// Jewish Federation of Greater Washington (shalomdc.org) — the DMV-wide Jewish
// community calendar, and the home of JConnect (the Federation's 20s/30s/40s arm).
//
// ⚠ The obvious domain is a decoy: **jconnect.org 403s EVERY path** — /events/,
// both REST namespaces, ?post_type=tribe_events — because it is only a redirect
// shell. In a browser it lands on shalomdc.org/jconnect/, and THAT host serves an
// open Tribe REST feed. Always follow the redirect before concluding a site needs
// a browser lane.
//
// The feed is broad (72 events over ~2 weeks) and a large share is early-childhood
// programming — playgroups, Music Together, Abrakadoodle, Baby & Me yoga — which is
// noise for this profile. We tag those `family` so the ranker sinks them rather than
// dropping them, since the same feed is the best source for High Holiday services
// and JConnect's young-professional events.
import { pathToFileURL } from 'node:url';
import { fetchJson, saveRaw, dateWindow, decodeEntities, stripTags } from '../lib.mjs';

const API = 'https://www.shalomdc.org/wp-json/tribe/events/v1/events';

const FAMILY_RE = /\b(playgroup|music together|abrakadoodle|baby|babies|toddler|mini doodlers|preschool|tot\b|kindergarten|first year moms|youth|teen|camp\b|b\'?nai mitzvah class|religious school)\b/i;
const YP_RE = /\b(jconnect|20s|30s|young professional|yp\b|young adult|post.?college|grad students?|moishe|2100)\b/i;

const CAT_TAGS = [
  [/shabbat|kabbalat|havdalah|service|minyan|torah|kol nidre|yizkor|neilah|selichot/i, ['jewish-religious']],
  [/high holiday|high holy|rosh hashanah|yom kippur|sukkot|simchat|tashlich|break.?fast/i, ['jewish-holiday']],
  [/concert|music|band|klezmer|sing/i, ['live-music']],
  [/author|book|lecture|talk|film|speaker|series/i, ['books']],
  [/volunteer|mitzvah day|food drive|pack|serve/i, ['volunteering']],
  [/hike|kayak|walk|outdoor|park|bike/i, ['outdoors']],
  [/dinner|brunch|lunch|potluck|bbq|s.?mores|happy hour/i, ['food-drink']],
];

export async function crawlShalomDC() {
  const days = dateWindow(8);
  const start = days[0], end = days.at(-1);
  const events = [];

  for (let page = 1; page <= 4; page++) {
    const url = `${API}?per_page=50&page=${page}&start_date=${start}&end_date=${end}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      if (page === 1) console.error(`[shalomdc] p1 failed: ${e.message}`);
      break;
    }
    for (const e of data.events || []) {
      const v = e.venue || {};
      const title = decodeEntities(e.title || '');
      const summary = stripTags(decodeEntities(e.description || e.excerpt || '')).replace(/\s+/g, ' ').trim();
      const cats = (e.categories || []).map((c) => decodeEntities(c.name));
      const blob = `${title} ${summary.slice(0, 300)} ${cats.join(' ')}`;

      const hintTags = new Set(['jewish']);
      if (FAMILY_RE.test(blob)) {
        hintTags.add('family');           // sinks it; do not add social/connection
      } else {
        hintTags.add('social');
        hintTags.add('connection');
        if (YP_RE.test(blob)) hintTags.add('jewish-scene');
      }
      for (const [re, tags] of CAT_TAGS) if (re.test(blob)) tags.forEach((t) => hintTags.add(t));

      events.push({
        title,
        start: (e.start_date || '').replace(' ', 'T').slice(0, 16),
        end: (e.end_date || '').replace(' ', 'T').slice(0, 16),
        url: e.website || e.url || '',
        venue: [decodeEntities(v.venue || ''), decodeEntities(v.address || '')].filter(Boolean).join(', '),
        city: decodeEntities(v.city || ''),
        price: decodeEntities(e.cost || ''),
        image: e.image?.url || '',
        summary: summary.slice(0, 300),
        categories: ['shalomdc', ...cats],
        hintTags: [...hintTags],
      });
    }
    if ((data.events || []).length < 50 || page >= (data.total_pages || 1)) break;
  }

  const fam = events.filter((e) => e.hintTags.includes('family')).length;
  console.log(`[shalomdc] ${events.length} events (${fam} tagged family/early-childhood)`);
  return saveRaw('shalomdc', events);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) crawlShalomDC();
