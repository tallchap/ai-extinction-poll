// Partiful has no public listings — events are invite links. Best-effort:
// Brave Search for publicly-indexed partiful.com event pages mentioning DC,
// then resolve each via og:/JSON-LD metadata. Low yield by design; the
// WhatsApp crawler is the richer Partiful source.
import { pathToFileURL } from 'node:url';
import { fetchJson, fetchText, saveRaw } from '../lib.mjs';
import { resolveEventUrl } from './whatsapp.mjs';

const BRAVE_KEY = process.env.BRAVE_API_KEY || 'BSA-rOEZoIo6LMboVof_WhiUdi-pBUn';
const QUERIES = [
  'site:partiful.com "washington dc" OR "washington, dc"',
  'site:partiful.com dc party',
  'site:partiful.com arlington OR alexandria OR bethesda OR "silver spring"',
  'site:partiful.com dupont OR "adams morgan" OR "capitol hill" OR "navy yard" OR shaw',
  'site:partiful.com jewish OR shabbat "washington dc" OR dc',
  'site:partiful.com salon OR "supper club" "washington dc" OR dc',
  'site:partiful.com "effective altruism" OR "ai policy" OR "ai safety" dc',
  // The lindy scene DOES post to Partiful, just not every week — a Wed Oct 1
  // "Swing Dance Lesson with John Jennings, Lindy hop" was live during the
  // 2026-09-06 sweep, outside that window. Keep the queries in permanently.
  'site:partiful.com "lindy hop"',
  'site:partiful.com "swing dance" dc OR washington OR arlington',
  'site:partiful.com bisexual OR "bi+" OR pansexual "washington dc" OR dc',
];

const DC_CITY_RE = /washington|\bdc\b|d\.c\.|arlington|alexandria|bethesda|silver spring|takoma|rosslyn|clarendon|ballston|crystal city|dupont|adams morgan|capitol hill|navy yard|georgetown|columbia heights|u street|shaw\b|noma|glen echo|chevy chase|college park|hyattsville/i;

export async function crawlPartiful() {
  const urls = new Map(); // url → result snippet
  // Partiful Explore pages are public server-rendered HTML with /e/<id> links.
  // /explore/nyc is the deep city page (~40 events vs 15 on the generic page).
  for (const page of ['https://partiful.com/explore/dc', 'https://partiful.com/explore']) {
    try {
      const html = await fetchText(page);
      for (const m of html.matchAll(/\/e\/([\w-]{10,25})/g)) {
        const u = `https://partiful.com/e/${m[1]}`;
        if (!urls.has(u)) urls.set(u, 'from Partiful Explore');
      }
    } catch (e) {
      console.error(`[partiful] ${page}: ${e.message}`);
    }
  }
  for (const q of QUERIES) {
    try {
      const data = await fetchJson(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&freshness=pm&count=20`,
        { headers: { 'X-Subscription-Token': BRAVE_KEY, Accept: 'application/json' } }
      );
      for (const r of data.web?.results ?? []) {
        const m = r.url?.match(/^https:\/\/partiful\.com\/e\/[\w-]+/);
        if (m && !urls.has(m[0])) urls.set(m[0], r.description || '');
      }
      await new Promise((res) => setTimeout(res, 1100)); // free-tier rate limit: 1 req/s
    } catch (e) {
      console.error(`[partiful] search "${q}": ${e.message}`);
    }
  }
  console.log(`[partiful] ${urls.size} indexed event pages; resolving…`);
  const events = [];
  for (const [url, snippet] of urls) {
    const rec = await resolveEventUrl(url, snippet);
    if (!rec) continue;
    // Explore mixes NYC/LA/SF — use city when present, else the page's timezone
    const place = `${rec.city} ${rec.venue} ${rec.title}`;
    if (rec.city && !DC_CITY_RE.test(place)) continue;
    // Bay Area leftover fixed here: the NYC fork still compares against LA time.
    if (!rec.city && rec.tz && rec.tz !== 'America/New_York') continue;
    events.push(rec);
  }
  return saveRaw('partiful', events);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) crawlPartiful().catch((e) => { console.error(e); process.exit(1); });
