// In-page extractor for facebook.com/events — run via browser automation
// (claude-in-chrome javascript_tool) in Ori's logged-in Chrome. Not a Node
// crawler: Facebook has no API, so an agent drives the browser, runs this,
// pulls the JSON out, and writes data/raw/facebook.json (parsing dateText
// like "Today at 5 PM" / "Wed, Sep 23 at 7:30 PM" to ISO).
//
// Flow: navigate facebook.com/events → scroll ~18×1600px with 900ms waits →
// run this → read window.__acc. /events/discover is dead (404); use the
// events hub and facebook.com/events/search?q=... pages.
window.__acc = window.__acc || {};
const NOISE = /^(Your events|See all|Discover events|Interested|Going|Share|·|\d+(\.\d+)?K? interested.*|.* is interested|.* invited you)$/;
const DATE_RE = /^((Today|Tomorrow) at|((Mon|Tue|Wed|Thu|Fri|Sat|Sun), )|Happening now)/;
for (const a of document.querySelectorAll('a[href*="/events/"]')) {
  const m = a.href.match(/facebook\.com\/events\/(\d+)/);
  if (!m || window.__acc[m[1]]) continue;
  let node = a.parentElement, card = null;
  for (let i = 0; i < 8 && node; i++) {
    const lines = (node.innerText || '').split('\n').filter(Boolean);
    if (lines.length >= 3 && lines.some((l) => DATE_RE.test(l))) { card = node; break; }
    node = node.parentElement;
  }
  if (!card) continue;
  const lines = card.innerText.split('\n').map((s) => s.trim()).filter((s) => s && !NOISE.test(s));
  const di = lines.findIndex((l) => DATE_RE.test(l));
  if (di < 0) continue;
  const interested = (card.innerText.match(/([\d.,]+K?) interested/) || [])[1] || '';
  const rec = { id: m[1], url: 'https://www.facebook.com/events/' + m[1], dateText: lines[di], title: lines[di + 1] || '', venue: lines[di + 2] || '', interested };
  if (rec.title) window.__acc[m[1]] = rec;
}
Object.keys(window.__acc).length;
