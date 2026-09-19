// District Fray (districtfray.com — dcfray.com redirects here) — DC's social-life
// magazine and events calendar. Register: rooftop trivia, bar bingo, polo, beach
// parties, run clubs, social sports, brewery things. The playful half of the
// "cool shit for young adults" lane; thingstododc is the embassy/boat-cruise half.
// Found 2026-09-18.
//
// WordPress. No JSON-LD and no usable REST for events, but the listing markup is
// stable: `article.event` with
//   p.date   → "Sunday, September 20, 2026 @ 1:30 pm"
//   h4.title > a → title + url
//   p.venue  → venue name (no address)
// The homepage carries the calendar; /events/ paginates.
import { pathToFileURL } from 'node:url';
import { fetchText, saveRaw, dateWindow, decodeEntities } from '../lib.mjs';

const LIST = 'https://districtfray.com/events/';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

// "Sunday, September 20, 2026 @ 1:30 pm" → "2026-09-20T13:30"
function parseWhen(s) {
  const m = s.match(/(\w+),\s*(\w+)\s+(\d{1,2}),\s*(\d{4})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0) return null;
  let h = Number(m[5]) % 12;
  if (/pm/i.test(m[7])) h += 12;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[4]}-${p(mo + 1)}-${p(Number(m[3]))}T${p(h)}:${m[6]}`;
}

const TAG_RULES = [
  [/trivia|bingo|game|quiz|puzzle|scavenger/i, ['games', 'social']],
  [/run club|5k|race|yoga|fitness|pilates|workout|hike|bike|climb/i, ['wellness', 'outdoors']],
  [/polo|kickball|softball|volleyball|bocce|cornhole|pickleball|league|tournament/i, ['sports', 'social']],
  [/rooftop|patio|beach|park|waterfront|outdoor|garden/i, ['outdoors']],
  [/brewery|beer|wine|cocktail|happy hour|brunch|tasting|food|distiller/i, ['food-drink']],
  [/concert|live music|band|dj\b|karaoke|open mic/i, ['live-music']],
  [/comedy|stand.?up|improv/i, ['comedy']],
  [/market|festival|fest\b|block party|pop.?up/i, ['festival']],
  [/single|speed dat|mixer|meet.?up|social club/i, ['singles']],
  [/drag|queer|lgbt|pride/i, ['social']],
  [/art|gallery|museum|craft|paint/i, ['arts']],
  [/dance|salsa|bachata|swing/i, ['dance-other']],
];

export async function crawlDistrictFray() {
  const win = new Set(dateWindow(8));
  const events = [];
  const seen = new Set();

  for (let page = 1; page <= 3; page++) {
    const url = page === 1 ? LIST : `${LIST}page/${page}/`;
    let html;
    try {
      html = await fetchText(url);
    } catch (e) {
      if (page === 1) console.error(`[districtfray] p1 failed: ${e.message}`);
      break;
    }

    const rows = html.split(/<article class="event"/).slice(1);
    if (!rows.length) break;
    let kept = 0;

    for (const row of rows) {
      const when = (row.match(/<p class="date">([\s\S]*?)<\/p>/) || [])[1] || '';
      const start = parseWhen(when.replace(/\s+/g, ' ').trim());
      if (!start || !win.has(start.slice(0, 10))) continue;

      const a = row.match(/<h4 class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const href = a[1];
      const title = decodeEntities(a[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!title || seen.has(href)) continue;
      seen.add(href);

      const venue = decodeEntities((row.match(/<p class="venue">([\s\S]*?)<\/p>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

      const blob = `${title} ${venue}`;
      const hintTags = new Set(['social']);
      for (const [re, tags] of TAG_RULES) if (re.test(blob)) tags.forEach((t) => hintTags.add(t));

      events.push({
        title, start, end: '', url: href,
        venue,
        city: 'Washington',
        price: '',
        image: (row.match(/<img src="(https:\/\/districtfray\.com\/wp-content\/[^"]+)"/) || [])[1] || '',
        summary: venue ? `District Fray listing at ${venue}.` : 'District Fray listing.',
        categories: ['districtfray'],
        hintTags: [...hintTags],
      });
      kept++;
    }
    if (kept === 0 && page > 1) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[districtfray] ${events.length} in-window events`);
  return saveRaw('districtfray', events);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) crawlDistrictFray();
