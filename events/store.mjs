// Durable store for the hosted deploy.
//
// Render's free web service has an EPHEMERAL filesystem and spins down after ~15
// minutes idle, so anything written to data/ is gone on the next cold start. That
// would silently empty the feed and erase the vote log that trains the ranker.
//
// So: Redis is the source of truth when REDIS_URL is set, and the repo's committed
// data/ snapshot is the cold-start fallback. Locally (no REDIS_URL) this is inert
// and everything stays on disk exactly as before.
//
// Hand-rolled RESP over node:tls — the project has zero npm dependencies and this
// keeps it that way. We only need GET/SET/APPEND-ish semantics.
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';

const URL_STR = process.env.REDIS_URL || '';
export const REDIS_ON = Boolean(URL_STR);

const KEY = (name) => `esdc:${name}`;

function parseUrl(u) {
  const m = u.match(/^rediss?:\/\/([^:]*):([^@]*)@([^:]+):(\d+)/);
  if (!m) throw new Error('REDIS_URL not in rediss://user:pass@host:port form');
  return { user: m[1], pass: m[2], host: m[3], port: Number(m[4]), tls: u.startsWith('rediss://') };
}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// Minimal RESP reader: enough for +OK, -ERR, :int, $bulk and *array-of-bulk.
function parseReply(buf) {
  let i = 0;
  function read() {
    const type = buf.charCodeAt(i); // buf is a binary STRING — charCodeAt, not buf[i] (that returns a char)
    const end = buf.indexOf('\r\n', i);
    if (end < 0) return undefined;
    const head = buf.slice(i + 1, end);
    if (type === 0x2b /* + */ || type === 0x3a /* : */) { i = end + 2; return head; }
    if (type === 0x2d /* - */) { i = end + 2; throw new Error(head); }
    if (type === 0x24 /* $ */) {
      const len = Number(head);
      i = end + 2;
      if (len === -1) return null;
      if (buf.length < i + len + 2) return undefined;
      const val = buf.slice(i, i + len);
      i += len + 2;
      return val;
    }
    if (type === 0x2a /* * */) {
      const n = Number(head);
      i = end + 2;
      if (n === -1) return null;
      const arr = [];
      for (let k = 0; k < n; k++) {
        const v = read();
        if (v === undefined) return undefined;
        arr.push(v);
      }
      return arr;
    }
    throw new Error(`unexpected RESP byte ${type}`);
  }
  const value = read();
  return value === undefined ? undefined : { value, consumed: i };
}

function command(args) {
  return new Promise((resolve, reject) => {
    const { user, pass, host, port, tls } = parseUrl(URL_STR);
    const sock = (tls ? tlsConnect : netConnect)(
      tls ? { host, port, servername: host } : { host, port },
    );
    let buf = '';
    let stage = 0; // 0 = awaiting AUTH reply, 1 = awaiting command reply
    const done = (fn, arg) => { try { sock.destroy(); } catch {} fn(arg); };

    sock.setTimeout(12000, () => done(reject, new Error('redis timeout')));
    sock.on('error', (e) => done(reject, e));
    // A TLSSocket emits BOTH 'connect' and 'secureConnect'. Binding the auth write
    // to both sends AUTH twice and desynchronises every reply that follows, which
    // surfaces as a bogus WRONGPASS. Bind exactly one, chosen by scheme.
    sock.once(tls ? 'secureConnect' : 'connect', () => sock.write(encode(['AUTH', user || 'default', pass])));
    sock.on('data', (chunk) => {
      buf += chunk.toString('binary');
      let parsed;
      try { parsed = parseReply(buf); } catch (e) { return done(reject, e); }
      if (parsed === undefined) return;
      buf = buf.slice(parsed.consumed);
      if (stage === 0) { stage = 1; return sock.write(encode(args)); }
      done(resolve, parsed.value);
    });
  });
}

export async function kvGet(name) {
  if (!REDIS_ON) return null;
  try {
    const v = await command(['GET', KEY(name)]);
    return v == null ? null : Buffer.from(v, 'binary').toString('utf8');
  } catch (e) { console.error(`[store] GET ${name}: ${e.message}`); return null; }
}

export async function kvSet(name, value) {
  if (!REDIS_ON) return false;
  try { await command(['SET', KEY(name), value]); return true; }
  catch (e) { console.error(`[store] SET ${name}: ${e.message}`); return false; }
}

export async function kvAppend(name, line) {
  if (!REDIS_ON) return false;
  try { await command(['APPEND', KEY(name), line]); return true; }
  catch (e) { console.error(`[store] APPEND ${name}: ${e.message}`); return false; }
}

export async function ping() {
  if (!REDIS_ON) return 'no REDIS_URL (local disk mode)';
  try { const r = await command(['PING']); return Buffer.from(r, 'binary').toString(); }
  catch (e) { return `ERR ${e.message}`; }
}
