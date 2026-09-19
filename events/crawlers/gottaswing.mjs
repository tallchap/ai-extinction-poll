// gottaswing.com/calendar — the DC swing scene's calendar (Tom Koerner &
// Debra Sternberg's Gottaswing runs the Glen Echo Spanish Ballroom Saturday
// dances, the Georgetown Waterfront summer socials and the weeknight classes
// across DC/MD/VA). WordPress + Modern Events Calendar (MEC lite): no REST
// feed, but the calendar page is server-rendered — one
// <div class="mec-calendar-events-sec" data-mec-cell="YYYYMMDD"> per day, one
// <article class="mec-event-article"> per event with .mec-event-time
// ("8:00 pm - 11:30 pm"), .mec-event-title a[href], .mec-event-loc-place.
// Each event page carries schema.org JSON-LD with the venue address and the
// description, so in-window events get a second fetch for those.
import { pathToFileURL } from 'node:url';
import { fetchText, saveRaw, dateWindow, decodeEntities, stripTags, inferCity } from '../lib.mjs';

const CAL = 'https://www.gottaswing.com/calendar';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function to24(t) {
  const m = (t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return '';
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
}

function hintTagsFor(text, title = '') {
  // Gottaswing's weeknight "Beginner/Intermediate Swing Class at <hall>" rows are
  // sessions of registered multi-week series, not drop-ins — useless to a
  // visitor. They keep dance-lesson only; dances, socials and weekend workshops
  // carry the swing-dance weight.
  const isSeries = /\b(class|classes|starts at)\b/i.test(title) && !/\b(dance party|social|workshop|drop.?in)\b/i.test(title);
  const tags = new Set(isSeries ? [] : ['swing-dance']);
  if (/\b(class|workshop|lesson|beginner|intermediate|crash course)\b/i.test(text)) tags.add('dance-lesson');
  if (/\b(band|jazz|orchestra|quartet|quintet|trio|live music|featuring)\b/i.test(text)) tags.add('live-music');
  if (/\b(waterfront|park\b|outdoor|open air|plaza)\b/i.test(text)) tags.add('outdoors');
  return [...tags];
}

function parseLd(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    try {
      const j = JSON.parse(m[1]);
      const arr = Array.isArray(j) ? j : [j];
      const ev = arr.find((x) => x && /Event/i.test(x['@type'] || ''));
      if (ev) return ev;
    } catch { /* keep looking */ }
  }
  return null;
}

export async function crawlGottaswing() {
  const days = dateWindow(8);
  const inWin = new Set(days.map((d) => d.replace(/-/g, '')));
  const html = await fetchText(CAL);
  const events = [];
  const secRe = /<div class="mec-calendar-events-sec"[^>]*data-mec-cell="(\d{8})"[^>]*>([\s\S]*?)(?=<div class="mec-calendar-events-sec"|<\/div>\s*<\/div>\s*<\/div>)/g;
  let sections = 0;
  for (const sec of html.matchAll(secRe)) {
    const cell = sec[1];
    if (!inWin.has(cell)) continue;
    sections++;
    const date = `${cell.slice(0, 4)}-${cell.slice(4, 6)}-${cell.slice(6, 8)}`;
    for (const art of sec[2].matchAll(/<article class="[^"]*mec-event-article[^"]*">([\s\S]*?)<\/article>/g)) {
      const a = art[1];
      const time = (a.match(/mec-event-time[^>]*>(?:<i[^>]*><\/i>)?\s*([^<]+)</) || [])[1] || '';
      const [t1, t2] = time.split(/\s*[-–]\s*/);
      const title = decodeEntities(stripTags((a.match(/<h4 class="mec-event-title">([\s\S]*?)<\/h4>/) || [])[1] || '')).replace(/\s+/g, ' ').trim();
      const url = (a.match(/href="([^"]+)"/) || [])[1] || CAL;
      const place = decodeEntities(stripTags((a.match(/mec-event-loc-place">([\s\S]*?)<\/div>/) || [])[1] || '')).trim();
      if (!title) continue;
      const rec = {
        title, start: `${date}T${to24(t1) || '00:00'}`, end: to24(t2) ? `${date}T${to24(t2)}` : '',
        url, venue: place, city: '', price: '', image: (a.match(/src="([^"]+)"/) || [])[1] || '',
        summary: '', categories: ['gottaswing'], hintTags: [],
      };
      // Detail page: JSON-LD carries the address + description.
      try {
        await sleep(400);
        const page = await fetchText(url);
        const ld = parseLd(page);
        if (ld) {
          const loc = ld.location || {};
          const addr = typeof loc.address === 'string' ? loc.address
            : loc.address ? [loc.address.streetAddress, loc.address.addressLocality, loc.address.addressRegion].filter(Boolean).join(', ') : '';
          if (addr) rec.venue = [place || loc.name, addr].filter(Boolean).join(', ');
          if (ld.description) rec.summary = decodeEntities(stripTags(ld.description)).replace(/\s+/g, ' ').slice(0, 300);
          const price = ld.offers?.price ?? ld.offers?.[0]?.price;
          if (price !== undefined && price !== '') rec.price = `$${price}`;
          if (ld.image) rec.image = Array.isArray(ld.image) ? ld.image[0] : ld.image;
        }
        if (!rec.summary) {
          const desc = (page.match(/mec-single-event-description[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
          rec.summary = decodeEntities(stripTags(desc)).replace(/\s+/g, ' ').slice(0, 300);
        }
        if (!/\d/.test(rec.venue)) {
          const addrTxt = (page.match(/mec-single-event-location[\s\S]*?<address[^>]*>([\s\S]*?)<\/address>/) || [])[1] || '';
          if (addrTxt) rec.venue = [place, decodeEntities(stripTags(addrTxt)).replace(/\s+/g, ' ').trim()].filter(Boolean).join(', ');
        }
      } catch (e) {
        console.error(`[gottaswing] ${url}: ${e.message}`);
      }
      // Venue first: descriptions mention 'Washington' or 'DC' for suburban halls.
      rec.city = inferCity(rec.venue) || (/glen echo|spanish ballroom|bumper car/i.test(rec.venue + title) ? 'Glen Echo' : '') || inferCity(rec.summary);
      rec.hintTags = hintTagsFor(`${title} ${rec.summary} ${rec.venue}`, title);
      if (!rec.hintTags.includes('swing-dance')) rec.summary = `Multi-week class series session (registration, not drop-in). ${rec.summary}`.slice(0, 300);
      if (!rec.summary) rec.summary = `${title} — from the Gottaswing DC swing calendar.`;
      events.push(rec);
    }
  }
  console.log(`[gottaswing] ${sections} in-window day sections, ${events.length} events`);
  return saveRaw('gottaswing', events);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) crawlGottaswing().catch((e) => { console.error(e); process.exit(1); });
