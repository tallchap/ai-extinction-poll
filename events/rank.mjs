// Score events against the interest profile + accumulated thumbs feedback.
// Pure local heuristic: no API calls, deterministic, instant.
import { pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readJsonIfExists, categorize, CATEGORY_LABELS } from './lib.mjs';

const TAG_LABELS = {
  'swing-dance': 'swing dancing', 'blues-dance': 'blues dancing', 'fusion-dance': 'fusion dance',
  tango: 'tango', 'dance-lesson': 'lesson included', 'dance-other': 'social dance', jam: 'music jam',
  'live-music': 'live music', jewish: 'Jewish community', 'jewish-culture': 'Jewish arts & culture',
  'jewish-scene': 'young Jewish scene', 'jewish-religious': 'services/shul',
  'jewish-holiday': 'holiday programming', singles: 'singles/dating',
  beatles: 'Beatles', 'pearl-jam': 'Pearl Jam', lighthaven: 'at Lighthaven',
  books: 'book club/reading', connection: 'connection & relating', bi: 'bi+ community',
  rationalist: 'rationalist/AI scene', 'ai-safety': 'AI safety', creator: 'video/creator industry',
  nightlife: 'club night', tech: 'tech scene', comedy: 'comedy', games: 'games night',
  social: 'social mixer', outdoors: 'outdoors', 'food-drink': 'food & drink', festival: 'festival', film: 'film',
};

// Options shown per day once voted events are set aside. Ori, 2026-09-09:
// "there are too many options — set a limit at 80 per day, and no more."
// profile.json `dailyCap` overrides. Voted events never count against the cap
// and are never dropped, so the shortlist and the passed list stay complete;
// as he votes things down, the next-best unvoted rows flow in from below.
const DEFAULT_DAILY_CAP = 80;

const FEEDBACK = join(DATA, 'feedback.jsonl');

function feedbackLines() {
  if (!existsSync(FEEDBACK)) return [];
  const out = [];
  for (const line of readFileSync(FEEDBACK, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return out;
}

// id → 'up' | 'down' for the current vote log. A skip clears nothing, it just
// isn't a vote. Shared with server.mjs so both agree on what "voted" means.
export function votedMap() {
  const map = {};
  for (const { id, vote } of feedbackLines()) {
    if (vote === 'skip') delete map[id];
    else if (vote === 'up' || vote === 'down') map[id] = vote;
  }
  return map;
}

// Every vote nudges that event's tags: +3 per thumbs-up, -3 per thumbs-down,
// clamped so no single tag can swamp the seed interests.
export function learnedWeights() {
  const weights = {};
  for (const { vote, tags = [] } of feedbackLines()) {
    const delta = vote === 'up' ? 3 : vote === 'down' ? -3 : 0;
    for (const t of tags) weights[t] = Math.max(-25, Math.min(25, (weights[t] || 0) + delta));
  }
  return weights;
}

// Votes also nudge the event's coarse category (±2, clamped ±15). This is what
// makes a thumbs-down on an untagged listing count for something: on
// 2026-09-09, 15 of 21 fresh votes landed on events with no interest tag at all
// and taught the tag weights nothing. The category comes from the live event
// while it is still in the window, else is re-derived from the logged title.
export function learnedCategoryWeights(eventsById = new Map()) {
  const weights = {};
  for (const { id, vote, title = '', tags = [] } of feedbackLines()) {
    const delta = vote === 'up' ? 2 : vote === 'down' ? -2 : 0;
    if (!delta) continue;
    const cat = eventsById.get(id)?.category || categorize({ title, tags });
    weights[cat] = Math.max(-15, Math.min(15, (weights[cat] || 0) + delta));
  }
  return weights;
}

// DC edition: home base not known yet (Sep 12-16 trip, arrives Union Station
// Sat afternoon). Until Ori names a neighborhood this is a pure Metro-reach
// signal: the core is a walk/short ride from anywhere central; the outer
// suburbs are a real trek without a car.
const NEIGHBORHOOD_BONUS = [
  [/\b(dupont|logan circle|u street|shaw|adams morgan|columbia heights|downtown|penn quarter|chinatown|navy yard|capitol hill|foggy bottom|georgetown|noma|union market|mt\.? vernon|mount vernon|h street|petworth|14th street|k street)\b/i, 6, 'central DC'],
  [/\b(glen echo|bethesda|silver spring|takoma|rosslyn|clarendon|ballston|crystal city|pentagon city|old town|alexandria|arlington|cherrydale)\b/i, 2, 'one Metro ride'],
  [/\b(warrenton|colvin run|great falls|reston|herndon|fairfax|manassas|gaithersburg|rockville|columbia,? md|laurel|annapolis|frederick|leesburg|ashburn|woodbridge|bowie|waldorf)\b/i, -8, 'far out without a car'],
];

export function rank() {
  const profile = readJsonIfExists(join(DATA, 'profile.json'), { interests: {}, cityBonus: {}, eveningBonus: 0 });
  const { events = [], today } = readJsonIfExists(join(DATA, 'events.json'), {});
  // normalize stamps the category; backfill so a rank-only run on an older
  // events.json still produces one for every row.
  for (const ev of events) ev.category ||= categorize(ev);
  const learned = learnedWeights();
  const learnedCategories = learnedCategoryWeights(new Map(events.map((e) => [e.id, e])));
  const voted = votedMap();

  for (const ev of events) {
    let score = 40;
    const why = [];
    for (const tag of ev.tags) {
      const seed = profile.interests[tag] || 0;
      const extra = learned[tag] || 0;
      if (seed + extra !== 0) {
        score += seed + extra;
        why.push({ label: TAG_LABELS[tag] || tag, pts: seed + extra });
      }
    }
    const catPts = learnedCategories[ev.category] || 0;
    if (catPts) {
      score += catPts;
      why.push({ label: `${CATEGORY_LABELS[ev.category] || ev.category} (your votes)`, pts: catPts });
    }
    const cityPts = profile.cityBonus[ev.city] ?? 0;
    score += cityPts;
    // Ori is staying in Chelsea, so walkability from there is real signal on top
    // of the borough bonus. Matched on the neighborhood text the listing prints.
    const hoodText = `${ev.city} ${ev.venue} ${ev.title}`;
    for (const [re, pts, label] of NEIGHBORHOOD_BONUS) {
      if (re.test(hoodText)) { score += pts; why.push({ label, pts }); break; }
    }
    for (const src of ev.sources) {
      const pts = profile.sourceBonus?.[src] ?? 0;
      if (pts) {
        score += pts;
        why.push({ label: src === 'whatsapp' ? 'shared in your groups' : `via ${src}`, pts });
      }
    }
    if (ev.hour !== null && ev.hour >= 17) {
      score += profile.eveningBonus;
      why.push({ label: 'evening', pts: profile.eveningBonus });
    }
    if (ev.rsvps && ev.rsvps >= 20) {
      score += 4;
      why.push({ label: `${ev.rsvps} going`, pts: 4 });
    }
    ev.score = Math.max(0, Math.min(100, Math.round(score)));
    why.sort((a, b) => b.pts - a.pts);
    ev.scoreReason = why.length
      ? why.slice(0, 3).map((w) => w.label).join(' · ')
      : 'no interest match yet — vote to teach me';
  }

  events.sort((a, b) => b.score - a.score || (a.date + '').localeCompare(b.date));

  // Daily cap: walk the score-sorted list and keep the top `cap` unvoted rows
  // per date. Voted rows always pass through and don't consume a slot.
  const cap = Number.isFinite(profile.dailyCap) ? profile.dailyCap : DEFAULT_DAILY_CAP;
  const dayCounts = {};
  const kept = [];
  for (const ev of events) {
    const dc = (dayCounts[ev.date] ??= { total: 0, shown: 0, voted: 0, trimmed: 0 });
    dc.total++;
    if (voted[ev.id]) { dc.voted++; kept.push(ev); continue; }
    if (dc.shown >= cap) { dc.trimmed++; continue; }
    dc.shown++;
    kept.push(ev);
  }

  writeFileSync(join(DATA, 'ranked.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), today, dailyCap: cap, dayCounts, learned, learnedCategories, events: kept,
  }, null, 2));
  const trimmed = Object.values(dayCounts).reduce((n, d) => n + d.trimmed, 0);
  console.log(`[rank] scored ${events.length} events, kept ${kept.length} (cap ${cap}/day, trimmed ${trimmed}); top: ${kept[0]?.title ?? '(none)'} (${kept[0]?.score ?? '-'})`);
  return kept;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) rank();
