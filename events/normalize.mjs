// Merge raw crawler output into data/events.json: one normalized, deduped,
// tagged, date-filtered feed.
import { pathToFileURL } from 'node:url';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA, RAW, readJsonIfExists, inferTags, inferCity, inRange, laDateStr, addDays, categorize } from './lib.mjs';

function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// NY-local "YYYY-MM-DD" and hour for an event start that may be an ISO string
// with timezone or a naive local "YYYY-MM-DDTHH:MM".
function localParts(start) {
  if (!start) return { date: '', hour: null };
  if (/[Zz]|[+-]\d\d:?\d\d$/.test(start)) {
    const d = new Date(start);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d));
    return { date, hour };
  }
  const m = start.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?/);
  return { date: m ? m[1] : '', hour: m && m[2] ? Number(m[2]) : null };
}

// A raw capture older than this is reported as stale by normalize().
const STALE_DAYS = 3;

export function normalize(windowDays = Number(process.env.WINDOW_DAYS) || 7) {
  const today = laDateStr();
  const last = addDays(today, windowDays - 1);
  // Six sources (facebook, instagram, partiful-personal, gmail) have NO Node crawler — they are browser-harvest or manual, so
  // scout.mjs never refreshes them, yet this function reads every raw file it
  // finds. A stale capture therefore rides into the feed looking exactly like
  // fresh data. On 2026-08-14 a two-week-old facebook.json cost the top-ranked
  // swing event of the week (Bootleggers Ball). Warn loudly per source.
  const all = [];
  const stale = [];
  for (const file of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
    const source = file.replace('.json', '');
    const raw = readJsonIfExists(join(RAW, file), {});
    const { events = [], crawledAt } = raw;
    const ageDays = crawledAt
      ? Math.floor((Date.now() - new Date(crawledAt).getTime()) / 86400000)
      : Infinity;
    if (ageDays >= STALE_DAYS) stale.push({ source, ageDays, n: events.length });
    for (const ev of events) all.push({ ...ev, source });
  }
  if (stale.length) {
    stale.sort((a, b) => b.ageDays - a.ageDays);
    console.warn(`[normalize] ⚠ ${stale.length} STALE source(s) — these have no crawler in scout.mjs and must be re-harvested by hand:`);
    for (const s of stale) {
      const age = Number.isFinite(s.ageDays) ? `${s.ageDays}d old` : 'no crawledAt';
      console.warn(`[normalize]   ${s.source} (${age}, ${s.n} events)`);
    }
  }

// Hard content exclusion for this edition: this feed gets shown to other
// people, so adult-oriented listings never enter it — not tagged, not demoted,
// not present. Matched against title + summary + categories + venue.
// DC edition: no Collider-style venue rule yet. The NYC fork tags anything at
// 26 Broadway as rationalist/ai-safety; DC's equivalents (CAIP, IAPS, CSET at
// Georgetown) co-host onto other calendars the same way — add a venue regex
// here once one is verified.
const COLLIDER_RE = /$^/;

const EXCLUDE_RE = /\b(femdom|fem dom|dominatrix|domme|findom|mistress|bdsm|kink|kinky|fetish|shibari|rope bondage|dungeon|play party|sex party|swingers?|orgy|munch|chastity|humiliation|pegging|sissy|sissies|latex night|leather (night|social|community)|folsom|dore alley|naked|nude|erotic|burlesque|strip(per|tease)|onlyfans|sensual|tantra|cuddle party|polyamor|swing(er|ing) club|tantric|massage)\b/i;

  const byKey = new Map();
  let dropped = 0; // out-of-range cities
  let excluded = 0; // hard-excluded by EXCLUDE_RE
  for (const ev of all) {
    const { date, hour } = localParts(ev.start);
    if (!date || date < today || date > last) continue;
    // Eventbrite organizer tags are keyword-stuffed (comedy nights tagged "Jewish"),
    // so only trust categories from curated sources.
    const cats = ev.source === 'eventbrite' ? [] : ev.categories || [];
    const text = `${ev.title} ${ev.summary || ''} ${cats.join(' ')} ${ev.venue || ''}`;
    // "munch" is a kink-scene word, but it is also what BiRequest calls its monthly
    // diner social ("Butta' Bisexual+ Munch", Hollywood Diner). When that word is
    // the only trigger and the listing is a bi+ community event, let it through.
    const exclHit = text.match(EXCLUDE_RE);
    if (exclHit && !(exclHit[0].toLowerCase() === 'munch' && inferTags(text).includes('bi'))) { excluded++; continue; }
    const city = ev.city || inferCity(text);
    if (!inRange(city)) { dropped++; continue; }
    // Collider (26 Broadway, FiDi) is the AI-safety coworking space; anything
    // held there is lane-relevant even when the listing never says "AI safety".
    // Venue-based because Collider has no calendar of its own (see crawlers/luma.mjs).
    const venueTags = COLLIDER_RE.test(text) ? ['rationalist', 'ai-safety'] : [];
    const tags = [...new Set([...inferTags(text), ...(ev.hintTags || []), ...venueTags])];
    // "open mic" earns the jam tag, but comedy open mics are not music jams —
    // when a night is explicitly comedy, let the comedy tag carry it alone.
    if (tags.includes('jam') && /\b(comedy|stand.?up|improv)\b/i.test(text) &&
        !/\b(jam session|jazz jam|blues jam|music jam|song circle|ukulele|bluegrass)\b/i.test(text)) {
      tags.splice(tags.indexOf('jam'), 1);
    }
    const key = `${normTitle(ev.title).slice(0, 40)}|${date}`;
    const id = createHash('md5').update(key + (ev.url || '')).digest('hex').slice(0, 12);
    const rec = {
      id,
      title: ev.title,
      date,
      hour,
      start: ev.start,
      end: ev.end || '',
      url: ev.url || '',
      venue: ev.venue || '',
      city,
      price: ev.price || '',
      image: ev.image || '',
      summary: (ev.summary || '').slice(0, 300),
      tags,
      sources: [ev.source],
      rsvps: ev.rsvps ?? null,
    };
    rec.category = categorize(rec);
    const existing = byKey.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, ev.source])];
      existing.venue ||= rec.venue;
      existing.city ||= rec.city;
      existing.price ||= rec.price;
      existing.image ||= rec.image;
      existing.summary ||= rec.summary;
      existing.tags = [...new Set([...existing.tags, ...rec.tags])];
      existing.category = categorize(existing);
    } else {
      byKey.set(key, rec);
    }
  }

  const kept = [...byKey.values()];

  const events = kept.sort((a, b) => (a.date + (a.hour ?? 0)).localeCompare(b.date + (b.hour ?? 0)));
  writeFileSync(join(DATA, 'events.json'), JSON.stringify({ generatedAt: new Date().toISOString(), today, events }, null, 2));
  console.log(`[normalize] ${all.length} raw → ${events.length} unique events (${today}..${last}); dropped ${dropped} out-of-range, ${excluded} excluded`);
  return events;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) normalize();
