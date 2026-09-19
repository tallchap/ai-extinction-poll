// Eventbrite NYC search pages — results ride in window.__SERVER_DATA__.
// Public search API was retired in 2020, so we read what the page itself renders from.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fetchText, saveRaw, laDateStr, addDays, readJsonIfExists, RAW } from '../lib.mjs';

// Category searches widen coverage, but their results are padded with generic
// filler once real matches run out — so they never assign tags (hintTags stays
// empty; tagging comes from title/summary regex and curated sources only).
const SEARCH_PATHS = [
  { path: 'all-events', hintTags: [] }, // broad sweep
  { path: 'singles', hintTags: [] },
  { path: 'jewish-events', hintTags: [] },
  { path: 'dance-events', hintTags: [] },
  { path: 'swing-dance', hintTags: [] },
  { path: 'lindy-hop', hintTags: [] },
  { path: 'effective-altruism', hintTags: [] },
  { path: 'ai-policy', hintTags: [] },
  { path: 'ai-safety', hintTags: [] },
  { path: 'video-editing', hintTags: [] },
  { path: 'filmmaking', hintTags: [] },
  { path: 'content-creator', hintTags: [] },
  { path: 'beatles', hintTags: [] },
  { path: 'pearl-jam', hintTags: [] },
  { path: 'jam-session', hintTags: [] },
  { path: 'open-mic', hintTags: [] },
  { path: 'book-club', hintTags: [] },
  { path: 'authentic-relating', hintTags: [] },
  { path: 'contact-improv', hintTags: [] },
  { path: 'immersive-experience', hintTags: [] },
  { path: 'supper-club', hintTags: [] },
  { path: 'bisexual', hintTags: [] }, // bi+ lane (2026-09-09)
];

function parsePage(html) {
  const m = html.match(/window\.__SERVER_DATA__\s*=\s*(\{.*?\});\s*\n/s);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  return data.search_data?.events?.results ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function crawlEventbrite(days = 7) {
  const start = laDateStr();
  const end = addDays(start, days - 1);
  const byId = new Map();

  // Eventbrite's limiter is CUMULATIVE over a sweep, not per-request: with 17
  // search paths the tail reliably 429s even though those same URLs serve 200
  // when fetched in isolation. So collect the paths that got refused and retry
  // them in later rounds with growing backoff, instead of losing whatever
  // happens to sit at the end of the list.
  // Rotate the start of the sweep each run so the same tail paths aren't always
  // the ones starved by the cumulative limiter (ai-safety/creator/... lost
  // every round at 30s/60s backoff), and give the retries real cooldown time.
  const rotated = SEARCH_PATHS.map((p) => ({ ...p }));
  const offset = new Date().getUTCHours() % rotated.length;
  let queue = [...rotated.slice(offset), ...rotated.slice(0, offset)];
  for (let round = 0; round < 4 && queue.length; round++) {
    if (round > 0) {
      const wait = 60000 * round;
      console.error(`[eventbrite] ${queue.length} path(s) rate-limited; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
    const refused = [];
    for (const entry of queue) {
      const { path, hintTags } = entry;
      let limited = false;
      for (let page = 1; page <= 2; page++) {
        // Space EVERY request, not just every path — the two page fetches used to
        // fire back-to-back, so a sweep was ~34 requests in bursts of two.
        await sleep(1500 + round * 1500);
        const url = `https://www.eventbrite.com/d/dc--washington/${path}/?start_date=${start}&end_date=${end}&page=${page}`;
        let results = [];
        try {
          results = parsePage(await fetchText(url));
        } catch (e) {
          if (/HTTP 429/.test(e.message)) limited = true;
          else console.error(`[eventbrite] ${path} p${page}: ${e.message}`);
          break;
        }
        if (!results.length) break;
      for (const r of results) {
        if (r.is_online_event || r.is_cancelled) continue;
        // keyword searches occasionally surface far-away events — NYC only
        const addr = r.primary_venue?.address ?? {};
        // DC edition: NY/NJ in the NYC fork — would drop every DC/MD/VA venue.
        if (addr.region && !['DC', 'MD', 'VA'].includes(addr.region)) continue;
        if (addr.country && addr.country !== 'US') continue;
        if (r.timezone && r.timezone !== 'America/New_York') continue;
        const existing = byId.get(r.id);
        if (existing) {
          existing.hintTags = [...new Set([...existing.hintTags, ...hintTags])];
          continue;
        }
        byId.set(r.id, {
          hintTags: [...hintTags],
          title: r.name,
          start: r.start_date && r.start_time ? `${r.start_date}T${r.start_time}` : r.start_date || '',
          end: r.end_date && r.end_time ? `${r.end_date}T${r.end_time}` : '',
          url: (r.url || '').split('?')[0],
          venue: r.primary_venue?.name || '',
          city: r.primary_venue?.address?.city || '',
          price: '',
          image: r.image?.url || '',
          summary: r.summary || '',
            categories: (r.tags || []).map((t) => t.display_name).filter(Boolean),
          });
        }
      }
      if (limited) refused.push(entry);
    }
    queue = refused;
  }
  if (queue.length) {
    console.error(`[eventbrite] gave up on ${queue.length} path(s) after retries: ${queue.map((q) => q.path).join(', ')}`);
  }
  if (byId.size === 0) {
    // total failure (usually a 429 burst) — keep the previous crawl instead of wiping it
    const prev = readJsonIfExists(join(RAW, 'eventbrite.json'), { events: [] });
    if (prev.events.length) {
      console.error(`[eventbrite] crawl empty; keeping previous ${prev.events.length} events`);
      return prev.events;
    }
  }
  return saveRaw('eventbrite', [...byId.values()]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) crawlEventbrite().catch((e) => { console.error(e); process.exit(1); });
