// WhatsApp groups → event links, read straight from the WhatsApp desktop app's
// local SQLite database (~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared).
// No pairing, no QR, no automation: the app itself syncs messages; we just read
// the file. Requires WhatsApp.app installed and linked (it is, as of 2026-07-26).
//
// History: Baileys/whatsapp-web.js QR pairing was abandoned — scans failed
// (likely linked-device limit) and whatsapp-web.js is broken vs current WA Web.
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DATA, fetchText, saveRaw, readJsonIfExists, stripTags } from '../lib.mjs';

const DB_DIR = join(homedir(), 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');
const CONFIG = readJsonIfExists(join(DATA, 'whatsapp.config.json'), { excludeGroups: [], lookbackDays: 7 });

const EVENT_URL_RE = /(https?:\/\/(?:lu\.ma|luma\.com|partiful\.com|www\.eventbrite\.com\/e|www\.meetup\.com\/[\w-]+\/events|fb\.me\/e|www\.facebook\.com\/events|dice\.fm|ra\.co\/events|withfriends\.co|posh\.vip|fetlife\.com\/events\/\d+)[^\s>"')\]]*)/gi;

export async function resolveEventUrl(url, context) {
  const rec = { title: '', start: '', end: '', url, venue: '', city: '', price: '', image: '', summary: context.slice(0, 200), categories: [] };
  try {
    const html = await fetchText(url, { timeoutMs: 12000 });
    const og = (p) => (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1] || '';
    rec.title = stripTags(og('title'));
    rec.image = og('image');
    if (!rec.summary) rec.summary = stripTags(og('description')).slice(0, 300);
    for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)) {
      try {
        let ld = JSON.parse(m[1]);
        if (Array.isArray(ld)) ld = ld.find((x) => /Event/.test(x['@type'] || '')) || {};
        if (/Event/.test(ld['@type'] || '')) {
          rec.title ||= stripTags(ld.name || '');
          rec.start = ld.startDate || rec.start;
          rec.end = ld.endDate || rec.end;
          rec.venue = ld.location?.name || rec.venue;
          rec.city = ld.location?.address?.addressLocality || rec.city;
        }
      } catch { /* not valid JSON-LD */ }
    }
    if (!rec.start) {
      const nd = html.match(/"start_at":"([^"]+)"/);
      if (nd) rec.start = nd[1];
    }
    rec.title = rec.title.replace(/\s*\|\s*Partiful$/i, '');
    const tz = html.match(/"time[Zz]one"\s*:\s*"(America\/[A-Za-z_]+)"/);
    if (tz) rec.tz = tz[1];
    const addr = html.match(/"address"\s*:\s*"([^"]+)"/);
    if (addr) {
      rec.venue ||= addr[1];
      const cityM = addr[1].match(/,\s*([A-Za-z .]+),\s*[A-Z]{2}\b/);
      rec.city ||= cityM ? cityM[1].trim() : '';
    }
  } catch (e) {
    console.error(`[whatsapp] resolve ${url}: ${e.message}`);
  }
  return rec.title && rec.start ? rec : null;
}

export async function crawlWhatsapp() {
  const src = join(DB_DIR, 'ChatStorage.sqlite');
  if (!existsSync(src)) {
    console.log('[whatsapp] WhatsApp.app database not found — is the desktop app installed?');
    return [];
  }
  // copy db (+wal/shm) so we never touch the app's live handle
  const tmp = join(tmpdir(), 'event-scout-wa.sqlite');
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext);
  }
  const appleEpoch = 978307200;
  const cutoff = Math.floor(Date.now() / 1000) - appleEpoch - CONFIG.lookbackDays * 86400;
  const sql = `SELECT c.ZPARTNERNAME as grp, m.ZTEXT as text
    FROM ZWAMESSAGE m JOIN ZWACHATSESSION c ON m.ZCHATSESSION = c.Z_PK
    WHERE c.ZCONTACTJID LIKE '%@g.us' AND m.ZTEXT IS NOT NULL AND m.ZMESSAGEDATE > ${cutoff}
    ORDER BY m.ZMESSAGEDATE DESC LIMIT 3000;`;
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', tmp, sql], { maxBuffer: 64 * 1024 * 1024 }).toString() || '[]');

  const found = new Map();
  for (const { grp, text } of rows) {
    if (CONFIG.excludeGroups.includes(grp)) continue;
    for (const [url] of (text || '').matchAll(EVENT_URL_RE)) {
      const clean = url.split('?')[0];
      if (!found.has(clean)) found.set(clean, `shared in "${grp}": ${text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  console.log(`[whatsapp] ${rows.length} recent group messages, ${found.size} event links; resolving…`);
  const events = [];
  for (const [url, context] of found) {
    const rec = await resolveEventUrl(url, context);
    if (rec) events.push(rec);
  }
  return saveRaw('whatsapp', events);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) crawlWhatsapp().catch((e) => { console.error(e); process.exit(1); });
