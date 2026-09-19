// Tribester (tribester.com) — a NATIONAL Jewish-events aggregator on The Events
// Calendar. Public Tribe REST feed, same shape as sixthandi. Found 2026-09-18
// via a Brave search for DC Jewish orgs; it carries listings no other lane has
// (e.g. IPF Atid DC's Shabbat dinner, and it is what finally named the venue for
// YJP DC's "Friday Night Live" — TheSHUL of the Nation's Capital — which the
// Instagram caption omitted).
//
// The feed is national, so the city filter IS the crawler. Venue city is
// authoritative when present; many listings use venue "TBD" with the city only
// in the blurb, so fall back to a text match for those.
import { pathToFileURL } from 'node:url';
import { fetchJson, saveRaw, dateWindow, decodeEntities, stripTags } from '../lib.mjs';

const API = 'https://tribester.com/wp-json/tribe/events/v1/events';

const DC_CITY = /^\s*(washington|arlington|alexandria|bethesda|silver spring|takoma park|rockville|college park|fairfax|glen echo|chevy chase|hyattsville|north bethesda|potomac|mclean|vienna|falls church)/i;
const DC_TEXT = /\b(washington,?\s*d\.?\s?c\.?|\bd\.?c\.?\b|dmv|arlington|alexandria|bethesda|silver spring|takoma|rockville|georgetown|dupont|capitol hill|adams morgan|columbia heights|navy yard|u street|shaw)\b/i;

const TAG_RULES = [
  [/shabbat|shabbos|kabbalat|friday night|havdalah/i, ['jewish-religious', 'social']],
  [/rosh hashanah|yom kippur|sukkot|simchat|high holiday|tashlich|kol nidre|break.?fast|teshuv/i, ['jewish-holiday']],
  [/20s|30s|young professional|yjp|moishe|grad students?|post.?college/i, ['jewish-scene', 'social']],
  [/dinner|brunch|potluck|bbq|lunch|poke|bagel|happy hour|cocktail/i, ['food-drink']],
  [/hike|kayak|outdoor|park|walk|bike|stroll/i, ['outdoors']],
  [/single|speed dat|matchmak|mixer/i, ['singles']],
  [/author|book|talk|lecture|learning|class|series/i, ['books']],
  [/concert|music|band|jam|sing/i, ['live-music']],
  [/volunteer|pack|serve|justice|tzedek/i, ['volunteering']],
];

export async function crawlTribester() {
  const days = dateWindow(8);
  const start = days[0], end = days.at(-1);
  const seen = new Set();
  const events = [];
  let national = 0;

  for (let page = 1; page <= 6; page++) {
    const url = `${API}?per_page=50&page=${page}&start_date=${start}&end_date=${end}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      if (page === 1) console.error(`[tribester] p1 failed: ${e.message}`);
      break;
    }
    const batch = data.events || [];
    national += batch.length;

    for (const e of batch) {
      const v = e.venue || {};
      const city = decodeEntities(v.city || '').trim();
      const venue = decodeEntities(v.venue || '').trim();
      const title = decodeEntities(e.title || '');
      const summary = stripTags(decodeEntities(e.description || e.excerpt || '')).replace(/\s+/g, ' ').trim();
      const blob = `${title} ${venue} ${city} ${summary.slice(0, 400)}`;

      const inDC = city ? DC_CITY.test(city) : DC_TEXT.test(blob);
      if (!inDC) continue;

      const key = (e.url || '') + title;
      if (seen.has(key)) continue;
      seen.add(key);

      const hintTags = new Set(['jewish', 'social', 'connection']);
      for (const [re, tags] of TAG_RULES) if (re.test(blob)) tags.forEach((t) => hintTags.add(t));

      events.push({
        title,
        start: (e.start_date || '').replace(' ', 'T').slice(0, 16),
        end: (e.end_date || '').replace(' ', 'T').slice(0, 16),
        url: e.website || e.url || '',
        venue: [venue, decodeEntities(v.address || '')].filter(Boolean).filter((x) => !/^TBD$/i.test(x)).join(', '),
        city: city || 'Washington',
        price: decodeEntities(e.cost || ''),
        image: e.image?.url || '',
        summary: summary.slice(0, 320),
        categories: ['tribester', ...(e.categories || []).map((c) => decodeEntities(c.name))],
        hintTags: [...hintTags],
      });
    }

    if (batch.length < 50 || page >= (data.total_pages || 1)) break;
  }

  console.log(`[tribester] ${national} national → ${events.length} DC-area`);
  return saveRaw('tribester', events);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) crawlTribester();
