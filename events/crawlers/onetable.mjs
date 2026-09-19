// OneTable — peer-hosted Shabbat / holiday dinners (free, RSVP, 20s-30s skew).
// dinners.onetable.org is a React app over a GraphQL API at
// app-prod.internal.onetable.org/graphql. Introspection is off, but the
// `events` query is public (no auth). Field names were recovered on
// 2026-09-08 from the server's "Did you mean" errors — there is no startsAt;
// the start is `scheduledAt`. Gotchas:
//   - DC edition: areaCode 'DC' (verified 2026-09-12: 61 events, Rosh Hashanah
//     Fri 9/18 dinners were the earliest — the window may legitimately be empty).
//   - NYC used areaCode 'NY' (from areaByUrl(url:"new_york") → {id:1, code:"NY"}).
//     areaUrl alone returned nothing.
//   - dateFrom/dateTo made totalCount 0 every way they were tried, so the
//     crawler pulls the whole NY list (perPage 200, ~200 rows) and windows
//     client-side on scheduledAt.
//   - `neighborhood` is a bare string and is really the borough/city
//     (Manhattan / Brooklyn / Queens / Hoboken / Staten Island).
//   - No public price field: dinners are free unless `pwyw` (pay what you wish).
//   - Fullness = reservationsTotal vs numberOfGuestsMax. The address is only
//     revealed after an accepted RSVP, so venue is the borough.
import { pathToFileURL } from 'node:url';
import { saveRaw, dateWindow } from '../lib.mjs';

const GQL = 'https://app-prod.internal.onetable.org/graphql';
const FIELDS = 'uuid title description scheduledAt endsAt timezone virtual eventType neighborhood state numberOfGuestsMax numberOfGuestsMin reservationsTotal alcoholPolicy dressCodeName pwyw potluck accessible eventSubtype { name } hosts { nodes { firstName } }';
const QUERY = `query events($perPage:Int,$offset:Int,$areaCode:String){ events(perPage:$perPage,offset:$offset,areaCode:$areaCode){ totalCount events { ${FIELDS} } } }`;

export async function crawlOnetable() {
  const days = dateWindow(8);
  const start = days[0], end = days.at(-1);
  const events = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset < 1000) {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://dinners.onetable.org', Referer: 'https://dinners.onetable.org/', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ operationName: 'events', query: QUERY, variables: { perPage: 200, offset, areaCode: 'DC' } }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map((e) => e.message).join('; '));
    const page = data.data?.events || {};
    total = page.totalCount ?? 0;
    const rows = page.events || [];
    if (!rows.length) break;
    offset += rows.length;
    for (const e of rows) {
      if (e.state !== 'PUBLISHED' || e.virtual) continue;
      const day = (e.scheduledAt || '').slice(0, 10);
      if (day < start || day > end) continue;
      const max = e.numberOfGuestsMax ?? null, taken = e.reservationsTotal ?? null;
      const full = max != null && taken != null && taken >= max;
      const left = max != null && taken != null ? Math.max(0, max - taken) : null;
      const hosts = (e.hosts?.nodes || []).map((h) => h.firstName).filter(Boolean).join(' & ');
      const holiday = /rosh|hashan|5787|new year|honey|shana/i.test(e.title + ' ' + (e.description || ''));
      events.push({
        title: `${e.title.trim()}${hosts ? ` — hosted by ${hosts}` : ''}`,
        start: e.scheduledAt,
        end: e.endsAt || '',
        url: `https://dinners.onetable.org/events/${e.uuid}/details`,
        venue: `${e.neighborhood || 'NYC'} (address shared after RSVP)`,
        city: e.neighborhood || 'Washington',
        price: e.pwyw ? 'pay what you wish' : e.potluck ? 'potluck' : 'free',
        image: '',
        summary: [
          `OneTable ${holiday ? 'Rosh Hashanah' : 'Shabbat'} dinner`,
          left != null ? (full ? 'FULL' : `${left} of ${max} seats left`) : '',
          e.alcoholPolicy ? e.alcoholPolicy.toLowerCase().replace(/_/g, ' ') : '',
          e.dressCodeName || '',
          (e.description || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        ].filter(Boolean).join(' · '),
        categories: ['OneTable', ...(e.eventSubtype?.name ? [e.eventSubtype.name] : [])],
        hintTags: ['jewish', 'social', 'food-drink', ...(holiday ? ['jewish-holiday'] : []), ...(full ? [] : [])],
        full,
      });
    }
  }
  return saveRaw('onetable', events);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) crawlOnetable().catch((e) => { console.error(e); process.exit(1); });
