// Luma discover page for DC — events ride in the page's __NEXT_DATA__ blob.
import { pathToFileURL } from 'node:url';
import { fetchJson, fetchText, saveRaw } from '../lib.mjs';

// City discover pages + venue/community calendars (coworking, AI-safety, EA).
const PAGES = [
  { url: 'https://lu.ma/dc', label: '' },
  // Fractal Campus NYC (111 Conselyea St, Williamsburg — the rationalist/builder
  // campus) publishes on luma.com/nyc-tech, ~15 upcoming at any time (Demo
  // Party, Data Salon, Hearth Social, reading groups). NOT lu.ma/nyctech — that
  // slug is a single 2022 fintech mixer's event page and was what this entry
  // pointed at until 2026-09-08, so Fractal never appeared in the feed.
  // --- AI-safety / EA / rationalist lane (the NYC analogue of Mox + Lighthaven).
  // These carry hintTags because a Luma calendar entry is one line of text with
  // no description — "AI Salon New York - AI & Human Flourishing" and
  // "AI Bagels @Union Square" infer NOTHING from title alone and were landing at
  // 56-58 instead of near the top. Membership in a curated calendar IS the
  // signal; the tag rules can't see it.
  // The city discover page misses all of these: EA NYC's meetup, the AI Salon
  // and AI Bagels were all absent from lu.ma/nyc on 2026-09-06.
  // EA NYC has NO vanity slug — every lu.ma/ea*nyc* guess 404s. Its calendar is
  // only reachable by api_id, and only under the /calendar/ prefix:
  // lu.ma/cal-… is 404, lu.ma/calendar/cal-… is 200.
  // DC edition (2026-09-12): lu.ma/ea-dc is EA DC's calendar (has_upcoming_events
  // true); lu.ma/eadc exists but is dormant. Every other slug guess — dcai,
  // dc-tech, aisafetydc, washington-dc — 404s. The AI Collective's DC chapter
  // posts under the shared genai-collective calendar (Founder Fridays, Arlington).
  { url: 'https://lu.ma/ea-dc', hintTags: ['rationalist', 'ai-safety'], label: 'EA DC' },
  { url: 'https://lu.ma/eadc', hintTags: ['rationalist', 'ai-safety'], label: 'EA DC (old)' },
  { url: 'https://lu.ma/genai-collective', hintTags: ['tech'], label: 'The AI Collective' },
  // Both dormant (re-checked 2026-09-08: has_upcoming_events false on each).
  // Collider, 26 Broadway, is the only real AI-safety coworking space in NYC but
  // it never lists on its own calendar — its events are co-hosted onto other
  // calendars (BlueDot's "State of AI Safety 2026" carried Collider as a host),
  // and collider.nyc/events is a 404. HOST_HINTS below is what actually catches
  // them. lu.ma/fractal is the "Fractal Social Cal!" — the real Fractal feed is
  // nyc-tech above. Both kept so the sweep notices the week either wakes up.
  // Luma's NYC AI discover page — LAST on purpose: pushEntry merges tags when an
  // event is seen twice, but curated-calendar labels should be the first copy.
  { url: 'https://luma.com/discover/dc/ai', label: '' },
];

// Hosts that mark an event as lane-relevant no matter which calendar it sits
// on. Luma entries carry `hosts: [{api_id, name}]` and `event.user_api_id`.
// Collider's Luma identity is usr-wBD3HCrBjz8KgEG (read off the hosts array of
// luma.com/state-of-ai-safety); it has no username, so match api_id first and
// the display name as a fallback.
const HOST_HINTS = [
  // DC edition: the AI-policy shops co-host onto other calendars the way
  // Collider does in NYC. Name matches only — api_ids not yet captured.
  { label: 'AI policy org', tags: ['rationalist', 'ai-safety'],
    match: (h) => /\b(center for ai policy|caip|iaps|institute for ai policy|cset|encode|ai safety dc|effective altruism dc|ea dc|bluedot|foundation for american innovation|future of life)\b/i.test(h.name || '') },
];

function hostHints(entry) {
  const hosts = [...(entry.hosts || []), { api_id: entry.event?.user_api_id, name: '' }];
  return HOST_HINTS.filter((r) => hosts.some((h) => h && r.match(h)));
}


// Luma's own paginated discover API — the same feed lu.ma/nyc renders, but the
// HTML page only ships the first ~20 entries in __NEXT_DATA__ while the API
// pages through the whole city (50/page). This is what lets HOST_HINTS and the
// Collider venue rule in normalize.mjs actually see Collider co-hosted events:
// they live on other people's calendars and never surface in the first 20.
// discplace-… is lu.ma/nyc's place id, read from its __NEXT_DATA__ (api_id);
// re-extracted from the page at runtime with the constant as fallback.
// discplace-AANPgOymN6bqFn8 is lu.ma/dc's place id (read 2026-09-12).
const NYC_PLACE_ID = 'discplace-AANPgOymN6bqFn8';
const API_FEEDS = [{ category: '' }, { category: 'ai' }];
const API_MAX_PAGES = 12; // 600 events, well past a 7-day window
const API_HORIZON_DAYS = 9;

async function crawlApi(seen, events, placeId) {
  const horizon = new Date(Date.now() + API_HORIZON_DAYS * 86400e3).toISOString();
  for (const feed of API_FEEDS) {
    let cursor = '';
    for (let page = 0; page < API_MAX_PAGES; page++) {
      const url = `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=50` +
        (feed.category ? `&discover_category_slug=${feed.category}` : '') +
        (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : '');
      let data;
      try {
        data = await fetchJson(url, { headers: { Accept: 'application/json' } });
      } catch (e) {
        console.error(`[luma] api ${feed.category || 'all'} p${page}: ${e.message}`);
        break;
      }
      const entries = data.entries || [];
      console.error(`[luma] api ${feed.category || 'all'} p${page}: ${entries.length} entries, has_more=${data.has_more}`);
      for (const entry of entries) pushEntry(entry, { label: '', hintTags: [] }, seen, events);
      const last = entries.at(-1)?.event?.start_at || entries.at(-1)?.start_at || '';
      if (!data.has_more || !data.next_cursor || !entries.length || last > horizon) break;
      cursor = data.next_cursor;
    }
  }
}

export async function crawlLuma() {
  const seen = new Map();
  const events = [];
  let placeId = NYC_PLACE_ID;
  for (const page of PAGES) {
    try {
      const html = await fetchText(page.url);
      const m = page.url === 'https://lu.ma/dc' && html.match(/"api_id":"(discplace-[A-Za-z0-9]+)"/);
      if (m) placeId = m[1];
      collect(html, page, seen, events);
    } catch (e) {
      console.error(`[luma] ${page.url}: ${e.message}`);
    }
  }
  await crawlApi(seen, events, placeId);
  return saveRaw('luma', events);
}

export function collect(html, page, seen, events) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  const data = JSON.parse(m[1]);

  // Event lists appear under initialData.data.events (shape has shifted before — walk defensively).
  const found = [];
  (function walk(o, depth = 0) {
    if (!o || depth > 8) return;
    if (Array.isArray(o)) {
      for (const item of o) walk(item, depth + 1);
      return;
    }
    if (typeof o !== 'object') return;
    if (o.event && (o.event.name || o.event.api_id)) found.push(o);
    for (const v of Object.values(o)) walk(v, depth + 1);
  })(data.props?.pageProps ?? data);

  for (const entry of found) pushEntry(entry, page, seen, events);
}

export function pushEntry(entry, page, seen, events) {
  const ev = entry.event;
  if (!ev?.name) return;
  // Fractal's calendar carries 'Private Event' placeholders — nothing to show.
  if (/^private event$/i.test(ev.name.trim())) return;
  const hints = hostHints(entry);
  const labels = [page.label, ...hints.map((h) => h.label)].filter(Boolean);
  const tags = [...new Set([...(page.hintTags ?? []), ...hints.flatMap((h) => h.tags)])];
  // Same event reached from two pages (a curated calendar and the city sweep):
  // keep the first record, union the labels and hintTags onto it.
  const prev = seen.get(ev.api_id);
  if (prev) {
    prev.categories = [...new Set([...prev.categories, ...labels])];
    prev.hintTags = [...new Set([...prev.hintTags, ...tags])];
    if (!prev.summary && labels.length) prev.summary = labels.map((l) => `on the ${l} calendar`).join('; ');
    return;
  }
  const rec = {
    title: ev.name,
    start: ev.start_at || entry.start_at || '',
    end: ev.end_at || '',
    url: ev.url ? `https://lu.ma/${ev.url}` : '',
    venue: ev.geo_address_info?.address || ev.geo_address_info?.city_state || '',
    city: ev.geo_address_info?.city || '',
    price: '',
    image: entry.cover_image?.url || ev.cover_url || '',
    summary: [page.label ? `on the ${page.label} calendar` : '', ...hints.map((h) => `hosted by ${h.label}`)].filter(Boolean).join('; '),
    categories: [...new Set(labels)],
    hintTags: tags,
  };
  seen.set(ev.api_id, rec);
  events.push(rec);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) crawlLuma().catch((e) => { console.error(e); process.exit(1); });
