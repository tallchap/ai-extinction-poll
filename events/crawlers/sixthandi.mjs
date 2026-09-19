// Sixth & I (sixthandi.org) — the downtown-DC historic synagogue that doubles as
// the city's Jewish-culture + author-talk venue. WordPress on The Events
// Calendar; the REST feed is public (verified 2026-09-12: 4 in-window events
// incl. a 20s&30s Rosh Hashanah lunch and an author evening). The HTML events
// page also renders, but the feed is structured.
import { pathToFileURL } from 'node:url';
import { fetchJson, saveRaw, dateWindow, decodeEntities } from '../lib.mjs';

const API = 'https://www.sixthandi.org/wp-json/tribe/events/v1/events';

// Sixth & I's own categories are good signal: map them onto our lanes.
const CAT_TAGS = [
  [/high holidays|holidays/i, ['jewish', 'jewish-holiday']],
  [/jewish life|jewish education/i, ['jewish']],
  [/20s (&|and|&amp;) 30s/i, ['jewish-scene', 'social']],
  [/authors? (&|and|&amp;) talks|talks (&|and|&amp;) entertainment|lectures?/i, ['books']],
  [/music|concert/i, ['live-music']],
  [/comedy/i, ['comedy']],
  [/shabbat|service|torah|learning|teshuvah/i, ['jewish-religious']],
];

export async function crawlSixthandi() {
  const days = dateWindow(8);
  const start = days[0], end = days.at(-1);
  const events = [];
  for (let page = 1; page <= 4; page++) {
    const url = `${API}?per_page=50&page=${page}&start_date=${start}&end_date=${end}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.error(`[sixthandi] p${page}: ${e.message}`);
      break;
    }
    for (const e of data.events || []) {
      const cats = (e.categories || []).map((c) => decodeEntities(c.name));
      const v = e.venue || {};
      const hintTags = new Set();
      for (const [re, tags] of CAT_TAGS) if (cats.some((c) => re.test(c))) tags.forEach((t) => hintTags.add(t));
      if (cats.some((c) => /jewish/i.test(c))) hintTags.add('jewish');
      events.push({
        title: decodeEntities(e.title || ''),
        start: e.utc_start_date ? e.utc_start_date.replace(' ', 'T') + 'Z' : (e.start_date || '').replace(' ', 'T'),
        end: e.utc_end_date ? e.utc_end_date.replace(' ', 'T') + 'Z' : '',
        url: e.website || e.url || '',
        venue: [decodeEntities(v.venue || 'Sixth & I'), v.address || '600 I St NW'].filter(Boolean).join(', '),
        city: v.city || 'Washington',
        price: e.cost || '',
        image: e.image?.url || '',
        summary: decodeEntities((e.excerpt || e.description || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 300),
        categories: ['sixthandi.org', ...cats],
        hintTags: [...hintTags],
      });
    }
    if (!data.next_rest_url || page >= (data.total_pages || 1)) break;
  }
  console.log(`[sixthandi] ${events.length} events`);
  return saveRaw('sixthandi', events);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) crawlSixthandi().catch((e) => { console.error(e); process.exit(1); });
