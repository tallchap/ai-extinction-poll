// Server for the recommender UI. Runs locally AND on Render.
//   GET  /api/events          → ranked feed + map of already-voted ids
//   POST /api/feedback        → {id, vote:"up"|"down"|"skip"} appends to the vote log
//                               {undo:true} pops the last vote
//   POST /api/rerank          → re-score with latest feedback
//   POST /api/refresh         → START a background re-crawl, returns immediately
//   GET  /api/refresh/status  → {state, startedAt, finishedAt, log, error}
//   GET  /api/health          → uptime + store mode
//
// HOSTING NOTES (Render free tier):
//  • The filesystem is EPHEMERAL and the service spins down after ~15 min idle, so
//    data/ cannot be the source of truth. When REDIS_URL is set, ranked.json and the
//    vote log live in Redis (see store.mjs) and disk is just a working cache.
//  • The repo's committed data/ snapshot is the cold-start fallback, so a fresh boot
//    always serves a real feed instead of an empty page.
//  • A full crawl takes 6-10 minutes (Eventbrite's cumulative rate-limit backoff), far
//    longer than any HTTP timeout, so /api/refresh is fire-and-forget + a status poll.
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT, DATA, readJsonIfExists } from './lib.mjs';
import { rank, votedMap } from './rank.mjs';
import { REDIS_ON, kvGet, kvSet, kvAppend, ping } from './store.mjs';

export const PORT = Number(process.env.PORT) || 4749; // NYC holds 4748, Bay Area 4747
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const FEEDBACK = join(DATA, 'feedback.jsonl');
const RANKED = join(DATA, 'ranked.json');
const EVENTS = join(DATA, 'events.json');
const BOOTED = new Date().toISOString();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const refreshState = { state: 'idle', startedAt: null, finishedAt: null, log: [], error: null };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// ── hydrate disk from Redis on boot, so a cold container serves real data ──
async function hydrate() {
  if (!REDIS_ON) return 'local disk mode';
  mkdirSync(DATA, { recursive: true });
  let restored = [];
  for (const [key, path] of [['ranked', RANKED], ['events', EVENTS], ['feedback', FEEDBACK]]) {
    const val = await kvGet(key);
    if (val && val.length) { writeFileSync(path, val); restored.push(`${key}(${val.length}b)`); }
  }
  // A vote may have landed while the box was asleep; re-rank so scores match the log.
  if (restored.some((r) => r.startsWith('feedback'))) { try { rank(); } catch {} }
  return restored.length ? `restored ${restored.join(' ')}` : 'redis empty — using committed snapshot';
}

async function persist() {
  if (!REDIS_ON) return;
  for (const [key, path] of [['ranked', RANKED], ['events', EVENTS]]) {
    if (existsSync(path)) await kvSet(key, readFileSync(path, 'utf8'));
  }
}

async function runRefresh() {
  refreshState.state = 'running';
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.error = null;
  refreshState.log = ['starting crawl…'];

  const origLog = console.log;
  console.log = (...a) => { // surface crawler progress to the UI
    const line = a.join(' ');
    if (/^\[/.test(line)) refreshState.log.push(line.slice(0, 200));
    if (refreshState.log.length > 60) refreshState.log.splice(0, refreshState.log.length - 60);
    origLog(...a);
  };
  try {
    const { crawlAll } = await import('./scout.mjs');
    await crawlAll();
    await persist();
    refreshState.state = 'done';
  } catch (e) {
    refreshState.state = 'error';
    refreshState.error = e.message;
    origLog('[refresh] failed:', e);
  } finally {
    console.log = origLog;
    refreshState.finishedAt = new Date().toISOString();
  }
}

export async function startServer() {
  mkdirSync(DATA, { recursive: true });
  const hydrated = await hydrate();
  console.log(`[store] ${hydrated}`);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true, booted: BOOTED, store: REDIS_ON ? 'redis' : 'disk',
          redis: REDIS_ON ? await ping() : null, refresh: refreshState.state,
        });
      }

      if (url.pathname === '/api/events') {
        const ranked = readJsonIfExists(RANKED, { events: [] });
        return json(res, 200, { ...ranked, voted: votedMap() });
      }

      if (url.pathname === '/api/refresh/status') return json(res, 200, refreshState);

      if (url.pathname === '/api/feedback' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.undo) {
          if (!existsSync(FEEDBACK)) return json(res, 200, { undone: null });
          const lines = readFileSync(FEEDBACK, 'utf8').split('\n').filter(Boolean);
          const popped = lines.pop();
          const next = lines.length ? lines.join('\n') + '\n' : '';
          writeFileSync(FEEDBACK, next);
          await kvSet('feedback', next);
          rank();
          await persist();
          return json(res, 200, { undone: popped ? JSON.parse(popped) : null });
        }
        const { id, vote, title, tags } = body;
        if (!id || !['up', 'down', 'skip'].includes(vote)) return json(res, 400, { error: 'bad vote' });
        const line = JSON.stringify({ at: new Date().toISOString(), id, vote, title, tags }) + '\n';
        appendFileSync(FEEDBACK, line);
        await kvAppend('feedback', line);
        if (vote !== 'skip') { rank(); await persist(); }
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/rerank' && req.method === 'POST') {
        rank();
        await persist();
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        if (refreshState.state === 'running') return json(res, 409, { ...refreshState, note: 'already running' });
        runRefresh(); // deliberately not awaited — a full crawl outlives any HTTP timeout
        return json(res, 202, { started: true, startedAt: refreshState.startedAt });
      }

      // static
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(ROOT, 'public', path.replace(/\.\./g, ''));
      if (existsSync(file)) {
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] || 'application/octet-stream',
          'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=300',
          'X-Robots-Tag': 'noindex',
        });
        return res.end(readFileSync(file));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      console.error(e);
      json(res, 500, { error: e.message });
    }
  });
  server.listen(PORT, HOST, () => console.log(`[server] listening on ${HOST}:${PORT}`));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) startServer();
