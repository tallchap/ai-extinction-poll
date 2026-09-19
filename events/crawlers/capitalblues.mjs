// Capital Blues (capitalblues.org) — THE blues-dance lane for DC.
// Weekly DJ'd "Back Room Blues" every Thursday at Glen Echo Park: beginner-
// friendly lesson 8:15pm (free with admission), dance 9pm.
//
// WordPress, but **no Tribe Events plugin** — /wp-json/tribe/... 404s and
// /events/ 404s. Only /wp-json/wp/v2/pages and /posts exist, and the blog posts
// are stale (the top "Weekly dances resume in October" post is from 2022, which
// is exactly the trap the STALE block exists for). The CURRENT schedule lives in
// the homepage body text, which does carry a recent dateModified.
//
// So: read the homepage, confirm the weekly cadence is still advertised, and
// synthesize the recurring Thursdays inside the window. Any one-off special is
// also announced on the homepage and is picked up by the SPECIAL regex.
import { pathToFileURL } from 'node:url';
import { fetchText, saveRaw, dateWindow, stripTags, decodeEntities } from '../lib.mjs';

const HOME = 'https://capitalblues.org/';
const VENUE = 'Glen Echo Park Back Room, 7300 MacArthur Blvd';
const CITY = 'Glen Echo';

export async function crawlCapitalBlues() {
  let text = '';
  try {
    const html = await fetchText(HOME);
    text = stripTags(decodeEntities(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')))
      .replace(/\s+/g, ' ');
  } catch (e) {
    console.error(`[capitalblues] homepage failed: ${e.message}`);
    return saveRaw('capitalblues', []);
  }

  const weekly = /every thursday night[\s\S]{0,200}?back room/i.test(text) || /weekly thursday night dances/i.test(text);
  if (!weekly) {
    console.log('[capitalblues] weekly Thursday cadence NOT found on homepage — not synthesizing. Check the site.');
    return saveRaw('capitalblues', []);
  }

  const lesson = (text.match(/join us at (\d{1,2}:\d{2}\s?[ap]m) for a beginner/i) || [])[1] || '8:15pm';
  const dance = (text.match(/the dance is at (\d{1,2})\s?pm/i) || [])[1] || '9';

  const events = [];
  for (const d of dateWindow(8)) {
    const dt = new Date(`${d}T12:00`);
    if (dt.getDay() !== 4) continue; // Thursday
    events.push({
      title: 'Back Room Blues — weekly DJ’d blues dance',
      start: `${d}T${String(dance).padStart(2, '0')}:00`,
      end: `${d}T23:59`,
      url: HOME,
      venue: VENUE,
      city: CITY,
      price: '',
      image: '',
      summary: `Capital Blues' weekly Thursday blues dance in the Back Room at Glen Echo Park. Beginner-friendly foundations lesson at ${lesson}, free with admission; dance at ${dance}pm. Recurring event synthesized from the homepage schedule, not a per-date listing.`,
      categories: ['capitalblues', 'weekly'],
      hintTags: ['blues-dance', 'dance-lesson', 'social', 'connection', 'live-music'],
    });
  }

  const special = text.match(/Thursday,\s+(\w+ \d{1,2}):\s*([^.]{10,160})/i);
  if (special) console.log(`[capitalblues] special announced: ${special[1]} — ${special[2].slice(0, 70)}`);

  console.log(`[capitalblues] ${events.length} weekly Thursday dance(s) in window`);
  return saveRaw('capitalblues', events);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) crawlCapitalBlues();
