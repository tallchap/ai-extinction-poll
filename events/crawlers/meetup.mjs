// Meetup find pages — events ride in __NEXT_DATA__'s Apollo cache as Event:* entries.
//
// Coverage notes (measured 2026-08-01): each request returns a HARD CAP of 12
// events and there is no pagination — &page / &pageToken / &after all return the
// identical 12. The dateRange presets also stop at next-week, so anything past
// ~8 days out was invisible. Two levers give real coverage:
//   1. per-day custom ranges (customStartDate/customEndDate) — 7 day-queries
//      returned 82 unique events where one week-range query returned 12;
//   2. &sortField=DATETIME returns a DIFFERENT slice of the same day (11 of 12
//      were new vs the default sort), so each day is swept under both orders.
import { pathToFileURL } from 'node:url';
import { fetchText, saveRaw, dateWindow } from '../lib.mjs';

const BASE = 'https://www.meetup.com/find/?location=us--dc--Washington&source=EVENTS';

// Keyword sweeps run against the preset ranges — they surface niche groups the
// broad per-day sweep's 12-item cap crowds out.
const KEYWORD_QUERIES = [
  '&dateRange=today',
  '&dateRange=tomorrow',
  '&dateRange=this-week',
  '&dateRange=this-weekend',
  '&dateRange=next-week',
  '&dateRange=next-week&keywords=dance',
  '&dateRange=next-week&keywords=jam',
  '&dateRange=next-week&keywords=jewish',
  '&dateRange=next-week&keywords=swing%20dance',
  '&dateRange=this-week&keywords=dance',
  '&dateRange=this-week&keywords=swing%20dance',
  '&dateRange=this-week&keywords=lindy%20hop',
  '&dateRange=next-week&keywords=lindy%20hop',
  '&dateRange=this-week&keywords=effective%20altruism',
  '&dateRange=this-week&keywords=ai%20policy',
  '&dateRange=this-week&keywords=rationalist',
  '&dateRange=this-week&keywords=jewish',
  '&dateRange=this-week&keywords=singles',
  '&dateRange=this-week&keywords=jam',
  '&dateRange=this-week&keywords=board%20games',
  '&dateRange=this-week&keywords=ai%20safety',
  '&dateRange=this-week&keywords=video%20editing',
  '&dateRange=this-week&keywords=filmmaking',
  '&dateRange=this-week&keywords=content%20creator',
  '&dateRange=this-week&keywords=podcast',
  '&dateRange=this-week&keywords=beatles',
  '&dateRange=this-week&keywords=pearl%20jam',
  '&dateRange=this-week&keywords=music%20jam',
  '&dateRange=this-week&keywords=open%20mic',
  '&dateRange=this-week&keywords=book%20club',
  '&dateRange=next-week&keywords=book%20club',
  '&dateRange=this-week&keywords=authentic%20relating',
  '&dateRange=this-week&keywords=contact%20improv',
  '&dateRange=next-week&keywords=connection',
  '&dateRange=this-week&keywords=strangers',
  '&dateRange=this-week&keywords=immersive',
  '&dateRange=this-week&keywords=supper%20club',
  // bi+ lane (2026-09-09)
  '&dateRange=this-week&keywords=bisexual',
  '&dateRange=next-week&keywords=bisexual',
  '&dateRange=this-week&keywords=bi%2B',
  '&dateRange=this-week&keywords=pansexual',
];

// Group event pages (meetup.com/<slug>/events/) render the same Apollo cache as
// /find, so they parse with parsePage unchanged. Use them for sparse lanes whose
// events the 12-item keyword cap would crowd out. bisexual-nyc = BiRequest's
// group (in-person 3rd Thursday social; Bi+ picnic etc). Verified 2026-09-09:
// 40 Event entries, ONLINE ones dropped by the existing eventType filter.
// DC edition: group pages (meetup.com/<slug>/events/) came back as a generic
// 'Bending Spoons' bot wall for dc-lindy-hop, gottaswing and effective-altruism-dc
// on 2026-09-12, while /find still renders. Empty until that changes.
const GROUP_PAGES = [];

function parsePage(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) return [];
  let apollo;
  try {
    apollo = JSON.parse(m[1]).props?.pageProps?.__APOLLO_STATE__ ?? {};
  } catch {
    return [];
  }
  const groups = {};
  for (const [k, v] of Object.entries(apollo)) if (k.startsWith('Group:')) groups[k] = v;
  const events = [];
  for (const [k, v] of Object.entries(apollo)) {
    if (!k.startsWith('Event:') || !v.title || v.eventType === 'ONLINE') continue;
    // keyword searches sometimes surface events far outside NYC
    // DC edition: the NYC fork keeps NY/NJ only — that line silently dropped every
    // DC/MD/VA venue on the first DC run (37 events, all venue-less).
    if (v.venue?.state && !['DC', 'MD', 'VA'].includes(v.venue.state.toUpperCase())) continue;
    const group = v.group?.__ref ? groups[v.group.__ref] : null;
    events.push({
      title: v.title,
      start: v.dateTime || '',
      end: v.endTime || '',
      url: (v.eventUrl || '').split('?')[0],
      venue: v.venue?.name || '',
      city: v.venue?.city || '',
      price: v.feeSettings?.amount ? `$${v.feeSettings.amount}` : '',
      image: v.featuredEventPhoto?.__ref ? '' : v.displayPhoto?.source || '',
      summary: [(group?.name || ''), (v.description || '').slice(0, 300)].filter(Boolean).join(' — '),
      categories: group?.name ? [group.name] : [],
      rsvps: v.rsvps?.totalCount ?? null,
    });
  }
  return events;
}

export async function crawlMeetup(days = 7) {
  const queries = [];
  for (const date of dateWindow(days)) {
    const range = `&dateRange=custom&customStartDate=${date}T00%3A00%3A00-04%3A00&customEndDate=${date}T23%3A59%3A00-04%3A00`;
    queries.push(range, `${range}&sortField=DATETIME`);
  }
  queries.push(...KEYWORD_QUERIES);

  const byUrl = new Map();
  for (const url of GROUP_PAGES) {
    try {
      for (const ev of parsePage(await fetchText(url))) {
        if (ev.url && !byUrl.has(ev.url)) byUrl.set(ev.url, ev);
      }
    } catch (e) {
      console.error(`[meetup] group ${url}: ${e.message}`);
    }
  }
  const CONCURRENCY = 4;
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    await Promise.all(queries.slice(i, i + CONCURRENCY).map(async (q) => {
      try {
        for (const ev of parsePage(await fetchText(BASE + q))) {
          if (ev.url && !byUrl.has(ev.url)) byUrl.set(ev.url, ev);
        }
      } catch (e) {
        console.error(`[meetup] ${q.slice(0, 60)}: ${e.message}`);
      }
    }));
  }
  return saveRaw('meetup', [...byUrl.values()]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) crawlMeetup().catch((e) => { console.error(e); process.exit(1); });
