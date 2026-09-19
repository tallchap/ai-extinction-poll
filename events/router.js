// Event Scout DC, mounted as a page on the always-on poll service.
//
// WHY IT LIVES HERE: as its own Render free service it cold-started for ~40s after
// 15 minutes idle, which made "open the events page" feel broken. This host is on a
// paid always-on plan, so the page is instant. Same code, same Redis keys (esdc:*)
// — only the front door changed.
//
// The event-scout code is ESM (.mjs) and this app is CommonJS, so the ESM modules are
// loaded lazily with dynamic import() and cached. Node supports that direction fine;
// the reverse (require() of ESM) would not work.
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const DIR = __dirname;
const DATA = path.join(DIR, 'data');
const RANKED = path.join(DATA, 'ranked.json');
const EVENTS = path.join(DATA, 'events.json');
const FEEDBACK = path.join(DATA, 'feedback.jsonl');

const router = express.Router();

let mods = null;
async function load() {
  if (!mods) {
    const [rank, store] = await Promise.all([
      import(path.join(DIR, 'rank.mjs')),
      import(path.join(DIR, 'store.mjs')),
    ]);
    mods = { rank, store };
  }
  return mods;
}

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

const refreshState = { state: 'idle', startedAt: null, finishedAt: null, log: [], error: null };
let hydrated = false;

// Redis is the source of truth; the committed data/ snapshot is the cold-start fallback.
// Hydrate once, lazily, so mounting this router never slows the host's boot.
async function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  const { store, rank } = await load();
  if (!store.REDIS_ON) return console.log('[esdc] no REDIS_URL — serving committed snapshot');
  try {
    let restored = [];
    for (const [key, file] of [['ranked', RANKED], ['events', EVENTS], ['feedback', FEEDBACK]]) {
      const val = await store.kvGet(key);
      if (val && val.length) { fs.writeFileSync(file, val); restored.push(key); }
    }
    if (restored.includes('feedback')) { try { rank.rank(); } catch {} }
    console.log(`[esdc] hydrated from redis: ${restored.join(',') || 'empty'}`);
  } catch (e) { console.error('[esdc] hydrate failed:', e.message); }
}

async function persist() {
  const { store } = await load();
  if (!store.REDIS_ON) return;
  for (const [key, file] of [['ranked', RANKED], ['events', EVENTS]]) {
    if (fs.existsSync(file)) await store.kvSet(key, fs.readFileSync(file, 'utf8'));
  }
}

async function runRefresh() {
  refreshState.state = 'running';
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.error = null;
  refreshState.log = ['starting crawl…'];
  const orig = console.log;
  console.log = (...a) => {
    const line = a.join(' ');
    if (/^\[/.test(line)) refreshState.log.push(line.slice(0, 200));
    if (refreshState.log.length > 60) refreshState.log.splice(0, refreshState.log.length - 60);
    orig(...a);
  };
  try {
    const scout = await import(path.join(DIR, 'scout.mjs'));
    await scout.crawlAll();
    await persist();
    refreshState.state = 'done';
  } catch (e) {
    refreshState.state = 'error';
    refreshState.error = e.message;
    orig('[esdc] refresh failed:', e);
  } finally {
    console.log = orig;
    refreshState.finishedAt = new Date().toISOString();
  }
}

router.use(async (req, res, next) => { try { await hydrateOnce(); } catch {} next(); });

router.get('/api/health', async (req, res) => {
  const { store } = await load();
  res.json({ ok: true, store: store.REDIS_ON ? 'redis' : 'disk',
    redis: store.REDIS_ON ? await store.ping() : null, refresh: refreshState.state, mountedOn: 'ai-extinction-poll' });
});

router.get('/api/events', async (req, res) => {
  const { rank } = await load();
  res.set('Cache-Control', 'no-store');
  res.json({ ...readJson(RANKED, { events: [] }), voted: rank.votedMap() });
});

router.get('/api/refresh/status', (req, res) => res.json(refreshState));

router.post('/api/refresh', (req, res) => {
  if (refreshState.state === 'running') return res.status(409).json({ ...refreshState, note: 'already running' });
  runRefresh(); // not awaited — a full crawl is 6-10 min, far past any HTTP timeout
  res.status(202).json({ started: true, startedAt: refreshState.startedAt });
});

router.post('/api/rerank', async (req, res) => {
  const { rank } = await load();
  rank.rank();
  await persist();
  res.json({ ok: true });
});

router.post('/api/feedback', async (req, res) => {
  const { rank, store } = await load();
  const body = req.body || {};
  if (body.undo) {
    if (!fs.existsSync(FEEDBACK)) return res.json({ undone: null });
    const lines = fs.readFileSync(FEEDBACK, 'utf8').split('\n').filter(Boolean);
    const popped = lines.pop();
    const next = lines.length ? lines.join('\n') + '\n' : '';
    fs.writeFileSync(FEEDBACK, next);
    await store.kvSet('feedback', next);
    rank.rank();
    await persist();
    return res.json({ undone: popped ? JSON.parse(popped) : null });
  }
  const { id, vote, title, tags } = body;
  if (!id || !['up', 'down', 'skip'].includes(vote)) return res.status(400).json({ error: 'bad vote' });
  const line = JSON.stringify({ at: new Date().toISOString(), id, vote, title, tags }) + '\n';
  fs.appendFileSync(FEEDBACK, line);
  await store.kvAppend('feedback', line);
  if (vote !== 'skip') { rank.rank(); await persist(); }
  res.json({ ok: true });
});

router.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex'); next(); });
router.use(express.static(path.join(DIR, 'public'), { index: 'index.html' }));

module.exports = router;
