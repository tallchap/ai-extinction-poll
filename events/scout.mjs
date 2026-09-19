// Orchestrator: crawl every source → normalize → rank, then serve + open the UI.
//   node scout.mjs              crawl, rank, start server, open browser
//   node scout.mjs --crawl-only crawl + rank and exit (used by /api/refresh)
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { crawlLuma } from './crawlers/luma.mjs';
import { crawlEventbrite } from './crawlers/eventbrite.mjs';
import { crawlMeetup } from './crawlers/meetup.mjs';
import { crawlPartiful } from './crawlers/partiful.mjs';
import { crawlGottaswing } from './crawlers/gottaswing.mjs';
import { crawlSixthandi } from './crawlers/sixthandi.mjs';
import { crawlTribester } from './crawlers/tribester.mjs';
import { crawlCapitalBlues } from './crawlers/capitalblues.mjs';
import { crawlShalomDC } from './crawlers/shalomdc.mjs';
import { crawlThingsToDoDC } from './crawlers/thingstododc.mjs';
import { crawlDistrictFray } from './crawlers/districtfray.mjs';
import { crawlOnetable } from './crawlers/onetable.mjs';
import { normalize } from './normalize.mjs';
import { rank } from './rank.mjs';

export async function crawlAll() {
  const crawlers = [crawlLuma, crawlEventbrite, crawlMeetup, crawlPartiful, crawlOnetable, crawlGottaswing, crawlSixthandi, crawlTribester, crawlCapitalBlues, crawlShalomDC, crawlThingsToDoDC, crawlDistrictFray];
  // DC edition (forked from NYC 2026-09-12). Dropped: skint + squarespace (NYC
  // venues), jewishsocial (NYC-only site), xscene. Added: gottaswing (the DC
  // swing calendar — Glen Echo + weeknight socials) and sixthandi (Sixth & I's
  // Tribe Events feed, the Jewish-culture anchor venue).
  await Promise.allSettled(
    crawlers.map((fn) =>
      fn().catch((e) => console.error(`[scout] ${fn.name} failed: ${e.message}`))
    )
  );
  normalize();
  rank();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  await crawlAll();
  if (!process.argv.includes('--crawl-only')) {
    const { startServer, PORT } = await import('./server.mjs');
    startServer();
    execFile('open', [`http://localhost:${PORT}`]);
  }
}
