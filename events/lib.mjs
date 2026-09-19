// Shared helpers for event-scout crawlers and pipeline.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const DATA = join(ROOT, 'data');
export const RAW = join(DATA, 'raw');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// Transient TLS/DNS resets sink a whole source for the run — 19hz in particular
// drops the first connection often enough that a single attempt loses ~100
// events. Retry network faults and 5xx only; 429 stays fatal so Eventbrite's
// own cumulative-limit backoff keeps seeing it.
export async function fetchText(url, opts = {}) {
  const tries = opts.tries ?? 3;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...opts.headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status === 429 || res.status < 500) throw err;
        lastErr = err;
        continue;
      }
      return res.text();
    } catch (e) {
      if (/HTTP \d{3}/.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

export function saveRaw(source, events) {
  mkdirSync(RAW, { recursive: true });
  writeFileSync(join(RAW, `${source}.json`), JSON.stringify({ crawledAt: new Date().toISOString(), events }, null, 2));
  console.log(`[${source}] ${events.length} events`);
  return events;
}

export function readJsonIfExists(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// Dates: everything keyed to America/New_York calendar days.
export function laDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00-04:00`);
  d.setDate(d.getDate() + n);
  return laDateStr(d);
}

export function dateWindow(days = 7) {
  const start = laDateStr();
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

export function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function stripTags(s) {
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Keyword → tag map used by normalize (title + summary + source categories).
const TAG_RULES = [
  // "balboa" is a swing style but also a SF theater, park, street, BART-adjacent
  // neighborhood and the 33 Balboa bus — those put an anime screening and a
  // Spanish conversation group in the top 10. Require it not be a place name.
  // The trailing \b used to apply to the whole group, which made "swing danc"
  // a DEAD alternative — there is no word boundary between the "c" and the "e"
  // of "swing dance", so no listing has ever matched on that phrase. Boundaries
  // are now per-alternative, and the stem matches dance/dancing/dancers.
  ['swing-dance', /\b(lindy hop\b|lindy\b|swing danc|(?<!\d\s)balboa\b(?!\s*(?:theat|park|st\b|street|ave|avenue|terrace|high|bart|reservoir))|shag\b|charleston\b|jitterbug\b)/i],
  ['blues-dance', /\bblues (danc|social|milonga|party|night)|\bblues fusion\b/i],
  ['fusion-dance', /\bfusion\b(?! (cuisine|restaurant|kitchen|sushi))/i],
  ['tango', /\b(milonga|argentine tango|tango)\b/i],
  ['dance-other', /\b(salsa|bachata|zouk|west coast swing|ecstatic dance|contra dance|waltz|two.?step)\b/i],
  // "all levels" is boilerplate on language meetups and fitness classes too, so
  // it no longer stands alone — the partner/lesson phrasings are dance-specific.
  ['dance-lesson', /\b(beginner (class|lesson)|intro (class|lesson)|lesson included|no partner)\b/i],
  ['live-music', /\b(live (band|music|jazz)|big band|orchestra|quartet|trio)\b/i],
  ['jam', /\b(jam session|open jam|open mic|music jam|blues jam|rock jam|guitar jam|ukulele jam|bluegrass jam|jazz jam|jam night|drum circle|song circle|sing.?along)\b/i],
  // Ori's two standing band obsessions — tribute nights, singalongs, anniversaries.
  ['beatles', /\b(beatles|beatle|john lennon|paul mccartney|george harrison|ringo starr|abbey road|sgt\.? pepper|fab four|rubber soul|yellow submarine)\b/i],
  ['pearl-jam', /\b(pearl jam|eddie vedder|vitalogy|ten club|stone gossard|mike mccready)\b/i],
  // "Israel" is also a common given name — "DJ Israel" was tagging a tango
  // practica as a Jewish event. Keep "israeli"; gate bare "Israel" on not being
  // used as a personal name.
  ['jewish', /\b(jewish|shabbat|havdalah|torah|moishe|chabad|kabbalat|klezmer|israeli\b|(?<!dj |dj\s)israel\b(?!\s*[,)])|hebrew|jcc)\b/i],
  // The bare 'jewish' tag is too coarse to learn from. Every Jewish event in a
  // Rosh Hashanah week carries it and nothing else, so a thumbs-up on a runway
  // show and a thumbs-down on a shul service move the SAME dial and cancel out
  // (2026-09-06: 5 votes produced exactly one learned weight, jewish:-9). These
  // three sub-lanes co-occur with the umbrella and give the ranker something to
  // actually separate. They are deliberately allowed to overlap.
  // Split on FORMAT, not on the holiday's name — "Rosh Hashana After Dark" is a
  // rooftop party, not a service, and lumping it with davening would rebuild the
  // same undifferentiated blob this split exists to break up.
  ['jewish-religious', /\b(services?\b|shul|synagogue|minyan|davening|torah|rabbi|rebbetzin|kabbalat|havdalah|chabad|young israel|jcc|crash course|class|learning|study|lecture)\b/i],
  ['jewish-holiday', /\b(rosh hashanah|rosh hashana|yom kippur|high holidays?|selichot|tashlich|sukkot|simchat torah|passover|pesach|chanukah|hanukkah|purim|shavuot|tisha b'av)\b/i],
  ['jewish-scene', /\b(yjp|young jewish professionals?|jewish (singles|mixer|social|crowd|professionals?)|moishe|ages 2\d.?.?3\d|20s and 30s|mingl)\b/i],
  ['jewish-culture', /\b(museum|gallery|exhibit|runway|fashion week|nyfw|klezmer|concert|film|screening|literary|author|art (show|auction|fair)|performance|theat\w+|comedy)\b/i],
  // Bi+ community events (Ori 2026-09-09: "add bisexual events"). The bare word
  // "bi" is too short to match on (bi-weekly, bilingual), so the rule needs the
  // full word, a bi+/bi-curious/pansexual spelling, a known NYC bi group, or
  // "bi <group noun>". `bi\+` deliberately has no trailing \b — "+" is not a
  // word character, so a boundary after it never matches before a space.
  ['bi', /(?:\b(?:bisexuals?|bisexuality|bi-?curious|pansexuals?|biromantic|bi ?request|binyc|nyabn|bi\+? ?(?:&|and) ?(?:pan|queer))\b|\bbi\+|\bpan\+|\bbi\/pan\b|\bbi (?:women|men|people|folks|social|meetup|mixer|night|party|community|brunch|happy hour|singles|dating|speed dating|visibility|pride)\b)/i],
  ['singles', /\b(speed dating|singles|mixer|matchmak|first dates?|mingle)\b/i],
  // Mox and Lighthaven are dedicated scene venues, so a venue match is real
  // signal. Frontier Tower is a 16-floor building whose other tenants run
  // generic corporate nights ("Stories of CFOs", "Hacking Employee Benefits"),
  // so its name alone no longer earns the tag — those events still qualify via
  // their own title/summary if they're actually on-topic.
  ['rationalist', /\b(rationalist|lesswrong|astral codex|acx|effective altruis|ai safety|ai alignment|agi|mox)\b/i],
  // AI safety as its own lane (overlaps rationalist by design — an alignment
  // talk at Mox earns both). Ori's day job, so it gets its own pinned chip.
  ['ai-safety', /\b(ai safety|ai alignment|alignment research|ai risk|existential risk|x.?risk|superintelligen|agi safety|ai governance|ai policy|responsible ai|interpretability|frontier model|catastrophic risk|doom)\b/i],
  // Video editing / creator economy. `youtuber?` used to match the bare word
  // "youtube" inside any pasted video URL — a 6am outdoor boot camp was tagged
  // creator on 2026-09-09 because its blurb linked a YouTube clip. Plural-only now.
  ['creator', /\b(video edit(or|ing)?|videograph(y|er)|filmmak(er|ing)|premiere pro|davinci resolve|after effects|final cut|motion graphics|color grading|content creator|creator economy|youtubers?|podcast(ing|er)|streamer|short.?form (video|content)|cinematograph)\b/i],
  ['tech', /\b(hackathon|founders?|startup|demo night|tech meetup|builders?)\b/i],
  ['comedy', /\b(comedy|stand.?up|improv|open mic comedy)\b/i],
  ['games', /\b(board game|trivia|chess|poker night|game night|puzzle)\b/i],
  // 19hz stamps every row categories:['nightlife'], which normalize folds into
  // the match text — without this rule those ~100 DJ nights carry zero tags, so
  // neither the seed profile nor thumbs-down votes can ever demote them.
  ['nightlife', /\bnightlife\b/i],
  ['books', /\b(book club|reading club|book group|reading group|silent reading|book swap|literary salon|author (talk|reading)|poetry (reading|gathering|slam)|writers? group|lit crawl|bookstore|read or write|writing hour|quiet reading|reading hour)\b/i],
  // "interesting social experiences" (Ori 2026-08-01, confirmed all four strands):
  // (a) authentic relating / circling, (b) stranger dinners & conversation salons,
  // (c) contact improv / touch-based, (d) weird novel one-off experiences.
  ['connection', new RegExp([
    // (a) facilitated relating
    'authentic relating', 'circling', 'connection game', 'deep (talk|listening|conversation)',
    'relational practice', 'human connection', 'meaningful conversation', 'encounter group',
    'nonviolent communication', '\\bnvc\\b', 'no small talk', 'big talk',
    // (b) strangers & salons
    'conversation salon', 'salon dinner', 'supper club', 'jeffersonian',
    'strangers? (dinner|dinners|meet|meetup|night|welcome)', '(dinner|dine|meet|talk|talking) with strangers',
    // (c) touch / body
    'cuddle (party|puddle|social)', 'contact improv', 'somatic', 'embodiment', 'embodied practice',
    // (d) novel one-offs
    'immersive (experience|theat\\w+|dinner|show)', 'interactive theat\\w+', 'participatory (art|performance|experience)',
    'experiential (dinner|workshop|art)', 'social experiment', 'mystery (event|dinner)', 'secret location',
  ].join('|'), 'i')],
  ['social', /\b(happy hour|meet ?up|social club|potluck|picnic|block party|networking)\b/i],
  ['outdoors', /\b(hike|hiking|outdoor|park|beach|bonfire)\b/i],
  ['food-drink', /\b(food festival|wine|beer|tasting|night market|supper club)\b/i],
  ['festival', /\b(festival|fair|bazaar|street party)\b/i],
  ['film', /\b(movie night|screening|film)\b/i],
];

// The LGBT Center's legal name is "The Lesbian, Gay, Bisexual & Transgender
// Community Center", so every listing held there — Toastmasters, tango class —
// contains the word "Bisexual". Collapse the spelled-out name before tagging so
// the bi rule only fires on listings that are actually about bi+ people.
const LGBT_NAME_RE = /\blesbian,?\s+gay,?\s+bisexual,?\s*(?:&|and)?\s*transgender\b/gi;

export function inferTags(text) {
  text = (text || '').replace(LGBT_NAME_RE, 'LGBT');
  const tags = new Set();
  for (const [tag, re] of TAG_RULES) if (re.test(text)) tags.add(tag);
  // The jewish-* sub-lanes describe WHICH KIND of Jewish event this is, so they
  // are meaningless without the umbrella and their vocabulary is far too generic
  // to stand alone: "Intro to Lindy Hop crash course" matched jewish-religious,
  // and a yacht party matched jewish-scene on "mingle". Gate them on the parent.
  if (!tags.has('jewish')) {
    for (const t of [...tags]) if (t.startsWith('jewish-')) tags.delete(t);
  }
  // West Coast Swing listings say "swing dance" and were riding the lindy weight
  // (Falls Church WCS levels 2-4 landed at 98 on the first DC run). Ori is here
  // for lindy hop only: without a lindy/balboa/charleston/jitterbug/shag mention,
  // a WCS event is dance-other, not swing-dance.
  if (tags.has('swing-dance') && /\bwest coast swing\b|\bwcs\b/i.test(text) && !/\b(lindy|balboa|charleston|jitterbug|shag)\b/i.test(text)) {
    tags.delete('swing-dance'); tags.add('dance-other');
  }
  // Registered multi-week class series (Gottaswing's weeknight rows, "NEW … CLASS
  // STARTS AT …") are not something a visitor can join; the text rule still tags
  // them swing-dance, so strip it here and leave dance-lesson.
  if (tags.has('swing-dance') && /\bmulti-week class series\b|\b(class|classes) starts\b|\bstarts at\b.*\b(studio|ballroom|hall|center|church)\b/i.test(text)) {
    tags.delete('swing-dance'); tags.add('dance-lesson');
  }
  return [...tags];
}

const CITY_RE = [
  // DC edition: neighborhoods → 'Washington'; the close-in MD/VA suburbs keep
  // their own names so cityBonus / NEIGHBORHOOD_BONUS can tell them apart.
  ['Washington', /\b(washington,? d\.?c\.?|washington dc|\bd\.?c\.?\b|dupont(?: circle)?|logan circle|u street|shaw|adams morgan|columbia heights|capitol hill|navy yard|foggy bottom|georgetown|noma|union market|mt\.? vernon (?:square|triangle)|mount vernon (?:square|triangle)|h street|petworth|penn quarter|chinatown|judiciary square|brookland|anacostia|tenleytown|cleveland park|woodley park|van ness|friendship heights|eckington|bloomingdale|ledroit|southwest waterfront|the wharf|west end|kalorama|glover park|cathedral heights|trinidad|ivy city|deanwood|congress heights|fort totten|takoma\b(?! park))\b/i],
  ['Arlington', /\b(arlington|rosslyn|clarendon|ballston|courthouse|crystal city|pentagon city|shirlington|cherrydale|virginia square)\b/i],
  ['Alexandria', /\b(alexandria|old town|del ray)\b/i],
  ['Bethesda', /\b(bethesda|chevy chase|friendship village)\b/i],
  ['Glen Echo', /\bglen echo\b/i],
  ['Silver Spring', /\bsilver spring\b/i],
  ['Takoma Park', /\btakoma park\b/i],
  ['College Park', /\b(college park|hyattsville|riverdale park|greenbelt)\b/i],
  ['Rockville', /\b(rockville|north bethesda|white flint|gaithersburg|germantown)\b/i],
  ['Fairfax', /\b(fairfax|falls church|tysons|mclean|vienna|reston|herndon|annandale|springfield|colvin run|great falls)\b/i],
  ['Warrenton', /\b(warrenton|manassas|leesburg|ashburn|woodbridge|fredericksburg)\b/i],
  ['Baltimore', /\b(baltimore|columbia,? md|annapolis|laurel|bowie|frederick)\b/i],
];

export function inferCity(text) {
  for (const [city, re] of CITY_RE) if (re.test(text || '')) return city;
  return '';
}

// DC edition: Metro-reachable only. Listings from Baltimore, Annapolis, outer
// Virginia and the exurbs ride in on the same feeds; normalize drops anything
// whose city is known AND absent from this list. A blank city is KEPT — most
// blank-city rows are local meetup/luma listings, so an unknown is not evidence
// of distance. Glen Echo is out past the Metro but IS the swing scene's home
// (Spanish Ballroom), so it stays in.
const IN_RANGE_CITIES = new Set([
  'washington', 'washington dc', 'washington, dc', 'washington, d.c.', 'dc', 'd.c.', 'district of columbia',
  'washington, district of columbia', 'washington, dc, usa',
  // DC neighborhoods listings use instead of a city
  'dupont', 'dupont circle', 'logan circle', 'u street', 'shaw', 'adams morgan', 'columbia heights',
  'capitol hill', 'navy yard', 'foggy bottom', 'georgetown', 'noma', 'union market', 'h street',
  'petworth', 'penn quarter', 'chinatown', 'brookland', 'tenleytown', 'cleveland park',
  'woodley park', 'friendship heights', 'southwest waterfront', 'the wharf', 'west end',
  'downtown', 'northwest dc', 'northeast dc', 'southeast dc', 'southwest dc', 'nw', 'ne', 'se', 'sw',
  // close-in Virginia
  'arlington', 'rosslyn', 'clarendon', 'ballston', 'crystal city', 'pentagon city', 'shirlington',
  'cherrydale', 'alexandria', 'old town', 'old town alexandria', 'del ray', 'falls church', 'tysons',
  'mclean', 'vienna', 'annandale', 'virginia',
  // close-in Maryland
  'bethesda', 'chevy chase', 'glen echo', 'silver spring', 'takoma park', 'college park',
  'hyattsville', 'greenbelt', 'rockville', 'north bethesda', 'wheaton', 'maryland',
]);

export function inRange(city) {
  const c = (city || '').trim().toLowerCase();
  if (!c) return true;
  return IN_RANGE_CITIES.has(c);
}

// ── Coarse category ─────────────────────────────────────────────────────────
// Exactly one per event, shown as the badge beside every title (Ori 2026-09-09:
// "each event in the listing should have a category right next to it"). The
// interest TAGS stay the fine-grained learning signal; this is the one-word
// answer to "what kind of thing is this?" so a row reads at a glance.
//
// Resolution order — first hit wins:
//   1. STRONG lanes by tag (already precise, and the lanes Ori cares about)
//   2. TEXT buckets on title + summary + venue, so the ~40% of listings that
//      carry no interest tag get a real category instead of "other"
//   3. WEAK tags (social / food-drink / outdoors) — these tag rules fire on
//      boilerplate like "networking" and "wine", so a text bucket such as
//      business or wellness should beat them
const CATEGORY_STRONG = [
  ['swing',       'swing',       ['swing-dance']],
  ['dance',       'dance',       ['blues-dance', 'fusion-dance', 'tango', 'dance-other', 'dance-lesson']],
  ['jam',         'jam',         ['jam']],
  ['connection',  'connection',  ['connection']],
  ['bi',          'bi+',         ['bi']],
  ['rationalist', 'rationalist/AI', ['rationalist', 'ai-safety']],
  ['books',       'books',       ['books']],
  ['rock',        'rock/indie',  ['rock']],
  ['music',       'music',       ['live-music', 'beatles', 'pearl-jam']],
  ['comedy',      'comedy',      ['comedy']],
  ['creator',     'creator',     ['creator']],
  ['singles',     'singles',     ['singles']],
  ['jewish',      'jewish',      ['jewish']],
  ['games',       'games',       ['games']],
  ['film',        'film',        ['film']],
  ['tech',        'tech',        ['tech']],
  ['festival',    'festival',    ['festival']],
  ['nightlife',   'nightlife',   ['nightlife']],
];
const CATEGORY_TEXT = [
  ['rock',      'rock/indie', /\b(black cat|dc9|pie shop|the atlantis|songbyrd|rhizome|comet ping ?pong|pearl street|velvet lounge|union stage|930 club|9:30 club|indie rock|punk|post.?punk|shoegaze|garage rock|noise rock|hardcore|emo\b|grunge|alt.?rock|rock show|doors at|record release)\b/i],
  ['music',     'music',     /\b(concert|live band|band\b|jazz|gig|recital|choir|chorus|karaoke|singer|songwriter|orchestra|symphony|album release|vinyl|dj set|open mic|acoustic|bluegrass|folk music|indie rock|classical music|piano|hip.?hop show|r&b night)\b/i],
  ['arts',      'arts',      /\b(art\b|arts\b|gallery|exhibit|exhibition|museum|theat(er|re)|\bplay\b|opera|ballet|photograph|painting|paint (&|and) sip|drawing|sketch|figure drawing|craft|ceramic|pottery|sculpture|design|fashion|sewing|knitting|crochet|embroidery|printmaking|calligraphy|zine|poetry|spoken word|storytelling|dance performance|musical\b|cabaret|drag show|circus|magic show|puppet)\b/i],
  ['wellness',  'wellness',  /\b(yoga|meditat\w*|breathwork|sound bath|fitness|run club|running club|workout|pilates|wellness|mindful\w*|therapy|healing|mental health|retreat|sauna|cold plunge|barre|bootcamp|hiit|zumba|tai chi|qigong|reiki|self.?care|journaling|recovery|sober|support group|grief)\b/i],
  ['family',    'family',    /\b(kids?|children|family|toddler|babies|baby|parents?|teens?|storytime|story time)\b/i],
  ['community', 'community', /\b(volunteer\w*|fundraiser|charity|benefit|donation|clean.?up|town hall|civic|advocacy|activis\w*|rally|protest|mutual aid|community (meeting|board|garden))\b/i],
  ['business',  'business',  /\b(networking|career|leadership|executive|marketing|sales|real estate|finance|investing|investor|entrepreneur\w*|webinar|summit|conference|panel|roundtable|professional|b2b|saas|founder|startup|venture|vc\b|pitch|linkedin|recruit\w*|hiring|job fair|women in|analytics|strategy|innovation|product management|fintech|blockchain|crypto|web3|\bai\b|artificial intelligence|machine learning|data science|developer|engineering|coding|hackathon)\b/i],
  ['class',     'class',     /\b(class|workshop|course|lesson|seminar|training|tutorial|masterclass|learn (to|how)|intro to|beginner|101\b)\b/i],
  ['food',      'food & drink', /\b(dinner|brunch|lunch|tasting|cooking|chef|wine|beer|cocktail|coffee|cafe|restaurant|pop.?up|supper|bake\w*|dessert|pizza|taco|bbq|barbecue|feast|potluck|picnic)\b/i],
  ['nightlife', 'nightlife', /\b(party|club night|rave|dj|djs|afterparty|after party|dance party|late night|nightclub|lounge)\b/i],
  ['outdoors',  'outdoors',  /\b(hike|hiking|walk\b|walking tour|bike ride|cycling|kayak|sail\w*|garden|park\b|rooftop|waterfront|beach|sunset|sunrise)\b/i],
  ['social',    'social',    /\b(mixer|meet ?up|happy hour|hangout|hang out|social|mingle|friends|game night|trivia|speed friending|newcomers?)\b/i],
];
const CATEGORY_WEAK = [
  ['food',     'food & drink', ['food-drink']],
  ['outdoors', 'outdoors',     ['outdoors']],
  ['social',   'social',       ['social']],
];

export const CATEGORY_LABELS = { other: 'other' };
for (const [k, l] of [...CATEGORY_STRONG, ...CATEGORY_TEXT, ...CATEGORY_WEAK]) CATEGORY_LABELS[k] ??= l;
// Grouping priority for the UI's "by category" view — interest lanes first.
export const CATEGORY_ORDER = [...new Set([...CATEGORY_STRONG, ...CATEGORY_TEXT, ...CATEGORY_WEAK].map(([k]) => k)), 'other'];

export function categorize(ev) {
  const tags = new Set(ev.tags || []);
  const text = `${ev.title || ''} ${ev.summary || ''} ${ev.venue || ''}`;
  for (const [key, , keyTags] of CATEGORY_STRONG) if (keyTags.some((t) => tags.has(t))) return key;
  for (const [key, , re] of CATEGORY_TEXT) if (re.test(text)) return key;
  for (const [key, , keyTags] of CATEGORY_WEAK) if (keyTags.some((t) => tags.has(t))) return key;
  return 'other';
}
