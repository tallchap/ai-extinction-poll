// Things To Do DC (thingstododc.com) — **the DC answer to Funcheap SF / The Skint**,
// and the "cool shit for young adults" listing this fork was missing. Embassy parties,
// rooftop things, boat/booze cruises, museum after-hours, food festivals, tastings.
// Found 2026-09-18.
//
// WordPress, but there is **no event post type and no Tribe plugin** —
// `wp-json/wp/v2/types` lists only post/page/attachment, and both
// `wp/v2/event(s)` and `tribe/events/v1/events` 404. Events are plain posts surfaced
// through a custom template, so the listing HTML is the API.
//
// The markup is stable and easy: one `div.w-row.event-list-row` per event, with
//   a[href*="/event/"]           → url
//   h3.event-listing-title       → title
//   strong.event-listing-date    → "Fri, Sep 18, 2026 at 07:30PM"
//   p.event-location             → a one-line blurb (NOT actually a location, despite
//                                  the class name — it is the description)
// Paginate with /events/all/page/N/.
import { pathToFileURL } from 'node:url';
import { fetchText, saveRaw, dateWindow, decodeEntities, inferCity } from '../lib.mjs';

const LIST = 'https://thingstododc.com/events/all/';

const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

// "Fri, Sep 18, 2026 at 07:30PM" → "2026-09-18T19:30"
function parseWhen(s) {
  const m = s.match(/(\w{3}),\s*(\w{3})\s+(\d{1,2}),\s*(\d{4})\s*at\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3)];
  if (mo == null) return null;
  let h = Number(m[5]) % 12;
  if (/pm/i.test(m[7])) h += 12;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[4]}-${p(mo + 1)}-${p(Number(m[3]))}T${p(h)}:${m[6]}`;
}

const TAG_RULES = [
  [/embassy|embassies|international|cultural/i, ['social', 'culture']],
  [/rooftop|garden party|waterfront|boat|cruise|sail|kayak|bike|outdoor|park/i, ['outdoors', 'social']],
  [/tasting|wine|beer|brewery|distiller|cocktail|food|dinner|brunch|margarita/i, ['food-drink']],
  [/museum|gallery|exhibit|art\b|after.?hours/i, ['arts']],
  [/concert|live music|band|jazz|dj\b|karaoke/i, ['live-music']],
  [/comedy|stand.?up|improv/i, ['comedy']],
  [/trivia|game|bingo|scavenger/i, ['games']],
  [/single|speed dat|mixer|meet/i, ['singles']],
  [/book|author|lecture|talk/i, ['books']],
  [/dance|salsa|bachata|swing/i, ['dance-other']],
  [/festival|fest\b|block party/i, ['festival']],
];

export async function crawlThingsToDoDC() {
  const win = new Set(dateWindow(8));
  const events = [];
  const seen = new Set();

  for (let page = 1; page <= 4; page++) {
    const url = page === 1 ? LIST : `${LIST}page/${page}/`;
    let html;
    try {
      html = await fetchText(url);
    } catch (e) {
      if (page === 1) console.error(`[thingstododc] p1 failed: ${e.message}`);
      break;
    }

    const rows = html.split(/<div class="w-row event-list-row/).slice(1);
    if (!rows.length) break;
    let kept = 0;

    for (const row of rows) {
      const href = (row.match(/href="(https:\/\/thingstododc\.com\/event\/[^"]+)"/) || [])[1];
      const title = decodeEntities((row.match(/<h3 class="event-listing-title">([\s\S]*?)<\/h3>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '').trim();
      const when = (row.match(/<strong class="event-listing-date">([\s\S]*?)<\/strong>/) || [])[1] || '';
      const blurb = decodeEntities((row.match(/<p class="event-location">([\s\S]*?)<\/p>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!href || !title) continue;

      const start = parseWhen(when.replace(/\s+/g, ' ').trim());
      if (!start || !win.has(start.slice(0, 10))) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const blob = `${title} ${blurb}`;
      const hintTags = new Set(['social']);
      for (const [re, tags] of TAG_RULES) if (re.test(blob)) tags.forEach((t) => hintTags.add(t));

      events.push({
        title,
        start,
        end: '',
        url: href,
        venue: '',
        city: inferCity(blob) || 'Washington',
        price: '',
        image: (row.match(/src="(https:\/\/thingstododc\.com\/wp-content\/[^"]+)"/) || [])[1] || '',
        summary: blurb.slice(0, 300),
        categories: ['thingstododc'],
        hintTags: [...hintTags],
      });
      kept++;
    }

    if (kept === 0 && page > 1) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[thingstododc] ${events.length} in-window events`);
  return saveRaw('thingstododc', events);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) crawlThingsToDoDC();
