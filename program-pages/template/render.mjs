// src/render.mjs  (pd-program-pages)
//
// THE program page template. One file, used in three places so what editors
// see is exactly what goes live:
//
//   1. scripts/build.mjs            renders every published program to static
//                                   HTML + the fragment the Cloudflare Worker uses.
//   2. pd-dashboard → program-pages/editor.js imports this file from the live
//                                   site (/_pd/render.mjs) and renders it in the
//                                   editor's iframe with { editable: true }.
//   3. test/render.test.mjs
//
// Changing the template = change this file and deploy this repo. The editor
// picks it up on next load; published pages pick it up on the next build.
//
// Rules for this file:
//   - No imports, no DOM, no Node APIs. It runs in the browser and in Node.
//   - Every value from the program JSON goes through esc() / attr() / safeUrl().
//     Editors are trusted staff, but the JSON is still user input and this HTML
//     is injected into pacificdiscovery.org.
//   - All CSS is scoped under .pdp so it can't fight the main site's Bootstrap.

// ─── small utils ────────────────────────────────────────────────────────────

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const attr = esc;

/** Allow http(s), mailto, tel, site-relative and in-page links. Everything else → '#'. */
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return '#';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (s.startsWith('#')) return s;
  return '#';
}

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function money(n, currency = 'USD') {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const s = v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return currency === 'USD' ? `$${s}` : `${currency} ${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseISO(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
export function dateRange(start, end) {
  const a = parseISO(start), b = parseISO(end);
  if (!a) return '';
  const fa = `${a.d} ${MONTHS[a.m - 1]}`;
  if (!b) return `${fa} ${a.y}`;
  const fb = `${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return a.y === b.y ? `${fa} – ${fb}` : `${fa} ${a.y} – ${fb}`;
}
export function shortDate(d) {
  const a = parseISO(d);
  return a ? `${MONTHS[a.m - 1]} ${a.d}, ${a.y}` : '';
}

/** Square-bracket text like "[Instructor name]" is a placeholder still to fill in. */
export function findPlaceholders(p) {
  const out = [];
  (function walk(v, path) {
    if (typeof v === 'string') { if (/\[[^\]]{2,}\]/.test(v)) out.push({ path, text: v }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
  })(p, '');
  return out;
}

// ─── the content model ──────────────────────────────────────────────────────
//
// SECTIONS is the order + labels the editor's "Sections" panel shows. The page
// stores its own order and visibility in p.layout so programs can differ.

export const SECTIONS = [
  { key: 'why',         label: 'Why this program',   anchor: 'why' },
  { key: 'route',       label: 'Route at a glance',  anchor: 'route' },
  { key: 'itinerary',   label: 'Itinerary',          anchor: 'itinerary', nav: 'Itinerary' },
  { key: 'day',         label: 'A day in the life',  anchor: 'day' },
  { key: 'stay',        label: 'Where you’ll stay',  anchor: 'stay', nav: 'Where you stay' },
  { key: 'learning',    label: 'Learning & credit',  anchor: 'learning' },
  { key: 'instructors', label: 'Instructors',        anchor: 'team' },
  { key: 'safety',      label: 'Safety & support',   anchor: 'safety', nav: 'Safety' },
  { key: 'cost',        label: 'Cost & inclusions',  anchor: 'cost', nav: 'Cost' },
  { key: 'reviews',     label: 'Reviews',            anchor: 'reviews' },
  { key: 'dates',       label: 'Dates',              anchor: 'dates', nav: 'Dates' },
  { key: 'faq',         label: 'FAQ',                anchor: 'faq', nav: 'FAQ' },
  { key: 'cta',         label: 'Closing call to action', anchor: 'apply' },
  { key: 'related',     label: 'You may also like',  anchor: 'related' },
];
const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

/**
 * Field definitions. The editor builds its side-panel forms from these, so
 * adding a field here is all it takes for editors to see it.
 *   type: text | multiline | number | money | date | url | image | select | toggle
 */
// Third-party review sites shown as badges in the hero. Named in text only —
// no logos or embed scripts, so nothing external runs on the page.
export const REVIEW_SOURCES = ['GoAbroad', 'GoOverseas', 'Google', 'Trustpilot', 'Other'];

/** A photo focal point, stored as "X% Y%". Anything else means "centre". */
export function parseFocus(v) {
  const m = /^\s*(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%\s*$/.exec(String(v || ''));
  if (!m) return '';
  const c = (n) => Math.round(Math.min(100, Math.max(0, Number(n))));
  return `${c(m[1])}% ${c(m[2])}%`;
}

/** Strip quote marks an editor typed around a testimonial; the page adds its own. */
export function stripQuotes(v) {
  return String(v || '').trim().replace(/^["'\u201C\u2018\u00AB\u201E]+\s*/, '').replace(/\s*["'\u201D\u2019\u00BB]+$/, '');
}

export const WIDGET_TYPES = ['GoAbroad', 'GoOverseas', 'Google'];

// Review wall: each card is a student/parent review or an award.
export const CARD_KINDS = ['Review', 'Award'];
export const REVIEW_SITES = ['', 'GoAbroad', 'GoOverseas', 'Google', 'Facebook', 'Instagram', 'Trustpilot', 'Other'];
const READ_MORE_AT = 190; // characters before a review gets a "Read more" toggle

/**
 * Turn whatever an editor pasted into a small, validated description of the
 * widget. The pasted code itself is NEVER output — the page rebuilds the embed
 * from these fields, so a bad paste can't inject anything.
 * @returns {null | {kind:'goabroad',src:string,width:number,height:number}
 *                 | {kind:'gooverseas',id:string,wtype:string,name:string,theme:string,link:string}
 *                 | {kind:'google',placeId:string}}
 */
export function parseWidget(w) {
  const type = String(w?.type || '');
  const code = String(w?.code || '').trim();
  if (!code) return null;
  if (type === 'GoAbroad') {
    const m = /https:\/\/www\.goabroad\.com\/reviews\/generator\/[A-Za-z0-9/_-]+(?:\?[A-Za-z0-9=&_.%-]*)?/.exec(code.replace(/&amp;/g, '&'));
    if (!m) return null;
    const num = (re, d) => { const x = re.exec(code); const v = x ? Number(x[1]) : d; return v >= 40 && v <= 1200 ? v : d; };
    return { kind: 'goabroad', src: m[0], width: num(/width:\s*(\d+)px/i, 352), height: num(/height:\s*(\d+)px/i, 84) };
  }
  if (type === 'GoOverseas') {
    const attr = (n) => { const x = new RegExp(`data-gooverseas-widget-${n}="([^"]*)"`, 'i').exec(code); return x ? x[1] : ''; };
    const id = attr('id') || (/^\d{1,10}$/.test(code) ? code : '');
    if (!/^\d{1,10}$/.test(id)) return null;
    const pick = (v, ok, d) => (ok.test(v) ? v : d);
    return {
      kind: 'gooverseas', id,
      wtype: pick(attr('type'), /^(program|provider)$/, 'program'),
      name: pick(attr('name'), /^[a-z]{1,30}$/, 'programshort'),
      theme: pick(attr('theme'), /^[a-z]{1,20}$/, 'primary'),
      link: pick(attr('link'), /^(yes|no)$/, 'yes'),
    };
  }
  if (type === 'Google') {
    const x = /(ChIJ[A-Za-z0-9_-]{10,200})/.exec(code);
    return x ? { kind: 'google', placeId: x[1] } : null;
  }
  return null;
}

// GoOverseas' own loader, verbatim from their embed code. Added once per page,
// only when a GoOverseas widget is present, and never inside the editor (the
// editor runs on the dashboard's origin, so no third-party script runs there).
const GOOVERSEAS_LOADER = '!function(e,s,r){e.GoOverseas=e.GoOverseas||function(){(e.GoOverseas.q=e.GoOverseas.q||[]).push(arguments)},e.GoOverseas.l=1*new Date;var a=s.createElement(r),n=s.getElementsByTagName(r)[0];a.async=1,a.src="https://www.gooverseas.com/static/0.2.0/main.min.js",n.parentNode.insertBefore(a,n)}(window,document,"script"),GoOverseas("review_widget_embed");';

export const SCHEMA = {
  page: {
    label: 'Page settings',
    fields: [
      { k: 'name', label: 'Program name', type: 'text', help: 'Used in the browser tab, the sticky bar and the program list.' },
      { k: 'seo.title', label: 'Search result title', type: 'text', help: 'Aim for under 60 characters.' },
      { k: 'seo.description', label: 'Search result description', type: 'multiline', help: 'Aim for 140–160 characters.' },
      { k: 'seo.ogImage', label: 'Social share image', type: 'image' },
      { k: 'settings.applyUrl', label: 'Apply link', type: 'url' },
      { k: 'settings.bookletUrl', label: 'Request booklet / itinerary link', type: 'url' },
      { k: 'settings.callUrl', label: 'Book a call link', type: 'url' },
      { k: 'settings.whatsappUrl', label: 'WhatsApp link', type: 'url' },
      { k: 'settings.currency', label: 'Currency', type: 'select', options: ['USD', 'NZD', 'AUD'] },
    ],
  },
  hero: {
    label: 'Hero',
    fields: [
      { k: 'hero.eyebrow', label: 'Small label above title', type: 'text' },
      { k: 'hero.headline', label: 'Headline', type: 'multiline' },
      { k: 'hero.intro', label: 'Intro', type: 'multiline' },
      { k: 'hero.image', label: 'Hero photo', type: 'image' },
      { k: 'hero.imageAlt', label: 'Hero photo description (alt text)', type: 'text' },
      { k: 'hero.imageFocus', label: 'Photo focus on computers', type: 'focus', image: 'hero.image', help: 'Click the part of the photo that should stay in view when the sides get cropped.' },
      { k: 'hero.imageFocusMobile', label: 'Photo focus on phones', type: 'focus', image: 'hero.image', mobile: true, help: 'Phones show a narrow slice of the photo. Click the part that must stay in view, e.g. a face.' },
    ],
  },
  facts: {
    label: 'Key facts',
    fields: [
      { k: 'facts.countries', label: 'Where', type: 'text' },
      { k: 'facts.start', label: 'Starts in', type: 'text' },
      { k: 'facts.finish', label: 'Finishes in', type: 'text' },
      { k: 'facts.weeks', label: 'Length (weeks)', type: 'number' },
      { k: 'facts.groupMax', label: 'Max group size', type: 'number' },
      { k: 'facts.ages', label: 'Ages', type: 'text' },
      { k: 'facts.tuition', label: 'Tuition', type: 'money' },
      { k: 'facts.promoPrice', label: 'Promotional price (optional)', type: 'money', help: 'Shows the normal tuition crossed out with this price next to it. Leave empty for no price change.' },
      { k: 'facts.promoText', label: 'Promotion message (optional)', type: 'text', help: 'A short line under the price, e.g. “Save $1,000 when you apply by Dec 1”. Works with or without a promotional price.' },
      { k: 'facts.promoEnds', label: 'Promotion ends (optional)', type: 'date', help: 'Last day of the promotion. It comes off the live page on its own the next morning.' },
      { k: 'facts.flightsEstimate', label: 'Estimated flights', type: 'money' },
      { k: 'facts.activityLevel', label: 'Activity level', type: 'select', options: ['Low', 'Medium', 'High'] },
      { k: 'facts.credit', label: 'College credit line', type: 'text' },
    ],
  },
  sections: {
    why:         { fields: [{ k: 'why.heading', label: 'Heading', type: 'text' }] },
    route:       { fields: [{ k: 'route.heading', label: 'Heading', type: 'text' }, { k: 'route.mapImage', label: 'Route map image', type: 'image' }, { k: 'route.mapAlt', label: 'Map description (alt text)', type: 'text' }] },
    itinerary:   { fields: [{ k: 'itinerary.heading', label: 'Heading', type: 'text' }, { k: 'itinerary.intro', label: 'Intro', type: 'multiline' }, { k: 'itinerary.note', label: 'Small print', type: 'text' }] },
    day:         { fields: [{ k: 'day.heading', label: 'Heading', type: 'text' }] },
    stay:        { fields: [{ k: 'stay.heading', label: 'Heading', type: 'text' }, { k: 'stay.intro', label: 'Intro', type: 'multiline' }] },
    learning:    { fields: [{ k: 'learning.heading', label: 'Heading', type: 'text' }] },
    instructors: { fields: [{ k: 'instructors.heading', label: 'Heading', type: 'text' }, { k: 'instructors.intro', label: 'Intro', type: 'multiline' }] },
    safety:      { fields: [{ k: 'safety.heading', label: 'Heading', type: 'text' }, { k: 'safety.linkText', label: 'Link text', type: 'text' }, { k: 'safety.linkUrl', label: 'Link', type: 'url' }] },
    cost:        { fields: [{ k: 'cost.heading', label: 'Heading', type: 'text' }, { k: 'cost.note', label: 'Note under the table', type: 'multiline' }] },
    reviews:     { fields: [{ k: 'reviews.heading', label: 'Heading', type: 'text' }, { k: 'reviews.visible', label: 'Cards shown before the “more” button', type: 'number', help: 'Usually 6 (two rows). 0 shows every card.' }, { k: 'reviews.moreText', label: '“More” button text', type: 'text' }, { k: 'reviews.videoUrl', label: 'YouTube or Vimeo link (optional)', type: 'url' }] },
    dates:       { fields: [{ k: 'dates.heading', label: 'Heading', type: 'text' }, { k: 'dates.help', label: 'Help line', type: 'text' }] },
    faq:         { fields: [{ k: 'faq.heading', label: 'Heading', type: 'text' }] },
    cta:         { fields: [{ k: 'cta.heading', label: 'Heading', type: 'text' }, { k: 'cta.body', label: 'Supporting line', type: 'text' }, { k: 'cta.primaryText', label: 'Main button text', type: 'text' }, { k: 'cta.secondaryText', label: 'Second button text', type: 'text' }] },
    related:     { fields: [{ k: 'related.heading', label: 'Heading', type: 'text' }] },
  },
  // Repeatable items. `blank` is what "+ Add" inserts.
  lists: {
    'hero.widgets':      { label: 'Live review widget', add: 'Add a live review widget', fields: [{ k: 'type', label: 'Widget', type: 'select', options: WIDGET_TYPES }, { k: 'code', label: 'Embed code or ID', type: 'multiline', help: 'GoAbroad or GoOverseas: paste the embed code they give you. Google: paste the Place ID (starts with ChIJ…). The rating updates on its own.' }], blank: { type: 'GoAbroad', code: '' } },
    'reviews.widgets':   { label: 'Live review widget', add: 'Add a GoAbroad or GoOverseas widget', fields: [{ k: 'type', label: 'Widget', type: 'select', options: WIDGET_TYPES }, { k: 'code', label: 'Embed code or ID', type: 'multiline', help: 'GoAbroad or GoOverseas: paste the embed code they give you (a review-list widget works well here). Google: paste the Place ID (starts with ChIJ…). Updates on its own.' }], blank: { type: 'GoOverseas', code: '' } },
    'hero.reviews':      { label: 'Review badge', add: 'Add a review badge', fields: [{ k: 'source', label: 'Review site', type: 'select', options: REVIEW_SOURCES }, { k: 'score', label: 'Score (e.g. 4.5 or 98%)', type: 'text' }, { k: 'count', label: 'Number of reviews', type: 'number' }, { k: 'url', label: 'Link to the reviews', type: 'url' }], blank: { source: 'GoAbroad', score: '', count: '', url: '' } },
    'why.items':         { label: 'Reason', add: 'Add a reason', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }, { k: 'image', label: 'Photo', type: 'image' }, { k: 'imageAlt', label: 'Photo description', type: 'text' }], blank: { title: 'New reason', body: 'Describe it in a sentence or two.', image: '', imageAlt: '' } },
    'route.phases':      { label: 'Phase', add: 'Add a phase', fields: [{ k: 'label', label: 'Weeks', type: 'text' }, { k: 'text', label: 'What happens', type: 'text' }], blank: { label: 'Wk', text: 'Location · headline activity' } },
    'itinerary.weeks':   { label: 'Week', add: 'Add a week', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'location', label: 'Location', type: 'text' }, { k: 'body', label: 'Description', type: 'multiline' }, { k: 'tags', label: 'Tags (comma separated)', type: 'text' }, { k: 'image', label: 'Photo', type: 'image' }, { k: 'imageAlt', label: 'Photo description', type: 'text' }], blank: { title: 'New week', location: '', body: 'What happens this week.', tags: '', image: '', imageAlt: '' } },
    'day.slots':         { label: 'Time slot', add: 'Add a time slot', fields: [{ k: 'time', label: 'Time', type: 'text' }, { k: 'text', label: 'Activity', type: 'text' }], blank: { time: '00:00', text: 'Activity' } },
    'day.notes':         { label: 'Note', add: 'Add a note', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }], blank: { title: 'Title', body: 'Text' } },
    'stay.items':        { label: 'Stay type', add: 'Add a stay type', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }, { k: 'image', label: 'Photo', type: 'image' }, { k: 'imageAlt', label: 'Photo description', type: 'text' }], blank: { title: 'New stay type', body: 'Describe it.', image: '', imageAlt: '' } },
    'learning.items':    { label: 'Learning card', add: 'Add a card', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }, { k: 'linkText', label: 'Link text', type: 'text' }, { k: 'linkUrl', label: 'Link', type: 'url' }], blank: { title: 'Title', body: 'Text', linkText: '', linkUrl: '' } },
    'instructors.people':{ label: 'Person', add: 'Add a person', fields: [{ k: 'name', label: 'Name', type: 'text' }, { k: 'role', label: 'Role', type: 'text' }, { k: 'bio', label: 'Bio', type: 'multiline' }, { k: 'photo', label: 'Photo', type: 'image' }], blank: { name: 'Name', role: 'Program Instructor', bio: 'Seasons led, certifications and a fun fact.', photo: '' } },
    'safety.items':      { label: 'Safety point', add: 'Add a point', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }], blank: { title: 'Title', body: 'Text' } },
    'cost.lines':        { label: 'Cost line', add: 'Add a cost line', fields: [{ k: 'label', label: 'Label', type: 'text' }, { k: 'amount', label: 'Amount (as shown)', type: 'text' }], blank: { label: 'Item', amount: '$0' } },
    'cost.included':     { label: 'Included item', add: 'Add an included item', fields: [{ k: 'text', label: 'Text', type: 'text' }], blank: { text: 'Included item' } },
    'cost.excluded':     { label: 'Not-included item', add: 'Add an item', fields: [{ k: 'text', label: 'Text', type: 'text' }], blank: { text: 'Not included' } },
    'reviews.quotes':    { label: 'Review card', add: 'Add a review or award', fields: [
      { k: 'kind', label: 'This card shows', type: 'select', options: CARD_KINDS, repaint: true },
      { k: 'quote', label: 'Review', type: 'multiline', when: ['kind', 'Review'], help: 'No need to type quote marks. The page adds them. Long reviews get a “Read more” link.' },
      { k: 'name', label: 'Who said it', type: 'text', when: ['kind', 'Review'] },
      { k: 'detail', label: 'Program or role (optional)', type: 'text', when: ['kind', 'Review'], help: 'e.g. “South America, Spring 2026” or “Parent”.' },
      { k: 'photo', label: 'Photo (optional)', type: 'image', when: ['kind', 'Review'], help: 'A small round photo. Without one, their initials show instead.' },
      { k: 'source', label: 'Posted on (optional)', type: 'select', options: REVIEW_SITES, when: ['kind', 'Review'] },
      { k: 'url', label: 'Link to the original review (optional)', type: 'url', when: ['kind', 'Review'] },
      { k: 'awardLabel', label: 'Small label', type: 'text', when: ['kind', 'Award'], help: 'e.g. “Go Overseas” or “2025”.' },
      { k: 'awardTitle', label: 'Award', type: 'text', when: ['kind', 'Award'], help: 'e.g. “Top Rated Program”.' },
      { k: 'awardText', label: 'Line underneath (optional)', type: 'text', when: ['kind', 'Award'] },
      { k: 'badge', label: 'Award badge image (optional)', type: 'image', when: ['kind', 'Award'], help: 'Use the official badge if you have one. Without it, laurels are drawn around the award.' },
      { k: 'badgeAlt', label: 'Badge description', type: 'text', when: ['kind', 'Award'] },
      { k: 'url', label: 'Link (optional)', type: 'url', when: ['kind', 'Award'] },
    ], blank: { kind: 'Review', quote: 'Review', name: 'Name', detail: '', photo: '', source: '', url: '', awardLabel: '', awardTitle: '', awardText: '', badge: '', badgeAlt: '' } },
    'dates.sessions':    { label: 'Start date', add: 'Add a start date', fields: [{ k: 'start', label: 'Start', type: 'date' }, { k: 'end', label: 'End', type: 'date' }, { k: 'season', label: 'Season', type: 'select', options: ['Spring', 'Summer', 'Fall', 'Winter'] }, { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Limited spots', 'Waitlist', 'Full', 'Closed'] }, { k: 'spotsLeft', label: 'Spots left (optional)', type: 'number' }, { k: 'applyUrl', label: 'Apply link (optional, overrides page default)', type: 'url' }], blank: { start: '', end: '', season: 'Spring', status: 'Open', spotsLeft: '', applyUrl: '' } },
    'faq.items':         { label: 'Question', add: 'Add a question', fields: [{ k: 'q', label: 'Question', type: 'text' }, { k: 'a', label: 'Answer', type: 'multiline' }], blank: { q: 'New question?', a: 'Answer.' } },
    'related.items':     { label: 'Related program', add: 'Add a program', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'meta', label: 'Length · price', type: 'text' }, { k: 'url', label: 'Link', type: 'url' }, { k: 'image', label: 'Photo', type: 'image' }], blank: { title: 'Program', meta: '10 weeks · $0', url: '', image: '' } },
  },
};

export function defaultLayout() {
  return SECTIONS.map((s) => ({ key: s.key, show: true }));
}

/** A new, empty-but-valid program. Bracketed text marks what's left to fill in. */
export function blankProgram(name = 'New program') {
  return {
    v: 1,
    name,
    seo: { title: `${name} | Pacific Discovery`, description: '', ogImage: '' },
    settings: {
      applyUrl: 'https://www.pacificdiscovery.org/apply',
      bookletUrl: 'https://www.pacificdiscovery.org/admissions/request-program-booklet',
      callUrl: '',
      whatsappUrl: '',
      currency: 'USD',
    },
    layout: defaultLayout(),
    hero: { eyebrow: 'Gap semester', headline: name, intro: '[One or two sentences on what makes this program special]', image: '', imageAlt: '', imageFocus: '', imageFocusMobile: '', widgets: [], reviews: [] },
    facts: { countries: '[Countries]', start: '', finish: '', weeks: 10, groupMax: 14, ages: '17–22', tuition: 0, promoPrice: '', promoText: '', promoEnds: '', flightsEstimate: 0, activityLevel: 'Medium', credit: 'Optional · University of Montana' },
    why: { heading: 'What makes this program different', items: [] },
    route: { heading: 'Your journey at a glance', mapImage: '', mapAlt: '', phases: [] },
    itinerary: { heading: 'Week by week', intro: '', note: 'This is a guide to what you can expect. The order of activities may change.', weeks: [] },
    day: { heading: 'What a typical day looks like', slots: [], notes: [] },
    stay: { heading: 'Where you’ll stay', intro: '', items: [] },
    learning: { heading: 'Learn while you travel', items: [] },
    instructors: { heading: 'Who you’ll travel with', intro: '', people: [] },
    safety: { heading: 'How we keep students safe', items: [], linkText: 'Read our full safety approach', linkUrl: 'https://www.pacificdiscovery.org/safety' },
    cost: { heading: 'What it costs, all in', lines: [], note: '', included: [], excluded: [] },
    reviews: { heading: 'From past students and parents', visible: 6, moreText: 'More reviews', videoUrl: '', widgets: [], quotes: [] },
    dates: { heading: 'Pick your start date', help: 'Not sure yet? Talk to an advisor.', sessions: [] },
    faq: { heading: 'Questions we get about this program', items: [] },
    cta: { heading: 'Ready to go?', body: '', primaryText: 'Apply now', secondaryText: 'Talk to an advisor' },
    related: { heading: 'You may also like', items: [] },
  };
}

/** Fill any keys a stored program is missing (older pages, new fields). */
export function normalizeProgram(p) {
  const base = blankProgram(p?.name || 'Program');
  const out = { ...base, ...(p || {}) };
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...((p && p[k]) || {}) };
    }
  }
  if (!Array.isArray(out.hero.reviews)) out.hero.reviews = [];
  if (!Array.isArray(out.hero.widgets)) out.hero.widgets = [];
  if (!Array.isArray(out.reviews.widgets)) out.reviews.widgets = [];
  if (!Array.isArray(out.reviews.quotes)) out.reviews.quotes = [];
  out.reviews.quotes = out.reviews.quotes.map((q) => ({ kind: 'Review', ...(q || {}), kind: q?.kind === 'Award' ? 'Award' : 'Review' }));
  // Pages saved before review badges existed had one free-text line.
  if (!out.hero.reviews.length && out.hero.reviewText) {
    out.hero.reviews = [{ source: 'Other', score: String(out.hero.reviewText), count: '', url: out.hero.reviewUrl || '' }];
  }
  delete out.hero.reviewText;
  delete out.hero.reviewUrl;
  const known = new Set(SECTIONS.map((s) => s.key));
  const seen = new Set();
  const layout = [];
  for (const l of Array.isArray(p?.layout) ? p.layout : []) {
    if (l && known.has(l.key) && !seen.has(l.key)) { layout.push({ key: l.key, show: l.show !== false }); seen.add(l.key); }
  }
  for (const s of SECTIONS) if (!seen.has(s.key)) layout.push({ key: s.key, show: true });
  out.layout = layout;
  return out;
}

// ─── rendering ──────────────────────────────────────────────────────────────

function ctx(p, opts) {
  const ed = !!opts.editable;
  const cur = p.settings?.currency || 'USD';

  // Editable text. In edit mode carries data-f so the editor can make it inline-editable.
  const t = (path, tag = 'span', cls = '', o = {}) => {
    const v = getPath(p, path);
    const empty = v == null || v === '';
    if (empty && !ed && !o.keep) return '';
    const ml = o.multiline ? ' pdp-ml' : '';
    const d = ed ? ` data-f="${attr(path)}"${o.multiline ? ' data-ml="1"' : ''}${empty ? ` data-empty="${attr(o.ph || 'Click to add text')}"` : ''}` : '';
    return `<${tag} class="${cls}${ml}"${d}>${esc(v)}</${tag}>`;
  };
  // Structured value (number, money, select…) edited from the side panel.
  const v = (path, display, tag = 'span', cls = '') => {
    const d = ed ? ` data-v="${attr(path)}"` : '';
    return `<${tag} class="${cls}"${d}>${esc(display)}</${tag}>`;
  };
  const img = (path, altPath, cls, label) => {
    const src = getPath(p, path);
    const alt = altPath ? getPath(p, altPath) : '';
    const d = ed ? ` data-img="${attr(path)}"${altPath ? ` data-alt="${attr(altPath)}"` : ''}` : '';
    if (!src) {
      return ed ? `<div class="pdp-img pdp-img--empty ${cls}"${d}><span>${esc(label || 'Add a photo')}</span></div>` : '';
    }
    return `<img class="pdp-img ${cls}" src="${attr(safeUrl(src))}" alt="${attr(alt || '')}" loading="lazy" decoding="async"${d}>`;
  };
  // Link whose label is editable inline and whose URL is edited in the panel.
  const link = (textPath, url, cls, urlPath) => {
    const text = getPath(p, textPath);
    if (!ed && !text) return '';
    const d = ed ? ` data-f="${attr(textPath)}"${urlPath ? ` data-url="${attr(urlPath)}"` : ''}` : '';
    return `<a class="${cls}" href="${attr(safeUrl(url))}"${d}>${esc(text)}</a>`;
  };
  // A repeatable list. `each(item, path, i)` renders one item's inner HTML.
  const list = (path, tag, cls, each, itemTag = 'div', itemCls = '') => {
    const items = getPath(p, path) || [];
    if (!items.length && !ed) return '';
    const inner = items.map((it, i) => {
      const ip = `${path}.${i}`;
      const html = each(it, ip, i);
      return html == null ? '' : `<${itemTag} class="${itemCls}"${ed ? ` data-item="${attr(ip)}"` : ''}>${html}</${itemTag}>`;
    }).join('');
    const add = ed ? `<button type="button" class="pde-add" data-add="${attr(path)}">+ ${esc(SCHEMA.lists[path]?.add || 'Add')}</button>` : '';
    return `<${tag} class="${cls}"${ed ? ` data-list="${attr(path)}"` : ''}>${inner}</${tag}>${add}`;
  };
  return { ed, cur, t, v, img, link, list };
}

const R = {
  why(p, c) {
    return `<h2 class="pdp-h2">${c.t('why.heading', 'span')}</h2>` +
      c.list('why.items', 'div', 'pdp-grid pdp-grid--4', (it, ip) =>
        `${c.img(`${ip}.image`, `${ip}.imageAlt`, 'pdp-card__img', 'Add a photo')}` +
        `<div class="pdp-card__body">${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.body`, 'p', 'pdp-muted', { multiline: true })}</div>`,
        'article', 'pdp-card');
  },
  route(p, c) {
    return `<h2 class="pdp-h2">${c.t('route.heading', 'span')}</h2>` +
      `<div class="${p.route.mapImage || c.ed ? 'pdp-split' : ''}">` +
      (p.route.mapImage || c.ed ? `<div class="pdp-route-map">${c.img('route.mapImage', 'route.mapAlt', 'pdp-route-map__img', 'Add a route map')}</div>` : '') +
      `<div>${c.list('route.phases', 'ol', 'pdp-phases', (it, ip) =>
        `${c.t(`${ip}.label`, 'strong', 'pdp-phase__label')}${c.t(`${ip}.text`, 'span', '')}`, 'li', 'pdp-phase')}</div>` +
      `</div>`;
  },
  itinerary(p, c) {
    const weeks = p.itinerary.weeks || [];
    const head = `<div class="pdp-head-row"><div><h2 class="pdp-h2">${c.t('itinerary.heading', 'span')}</h2>${c.t('itinerary.intro', 'p', 'pdp-lede', { multiline: true })}</div>` +
      (p.settings?.bookletUrl ? `<a class="pdp-btn pdp-btn--ghost" href="${attr(safeUrl(p.settings.bookletUrl))}">Download full itinerary</a>` : '') + `</div>`;
    const body = (it, ip, i) => {
      const tags = String(it.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      const title = `<span class="pdp-week__num">Week ${i + 1}</span>${c.t(`${ip}.title`, 'span', 'pdp-week__title')}${it.location || c.ed ? c.t(`${ip}.location`, 'span', 'pdp-week__loc', { ph: 'Location' }) : ''}`;
      const inner = `<div class="pdp-week__body"><div>${c.t(`${ip}.body`, 'p', '', { multiline: true })}` +
        (tags.length ? `<ul class="pdp-tags">${tags.map((tg) => `<li>${esc(tg)}</li>`).join('')}</ul>` : '') +
        `</div>${c.img(`${ip}.image`, `${ip}.imageAlt`, 'pdp-week__img', 'Add a photo for this week')}</div>`;
      // <details> works with no JavaScript on the live site. In the editor it's a
      // plain block so clicking the title edits it instead of collapsing it.
      return c.ed
        ? `<div class="pdp-week__sum">${title}</div>${inner}`
        : `<details${i === 0 ? ' open' : ''}><summary class="pdp-week__sum">${title}<span class="pdp-chev" aria-hidden="true"></span></summary>${inner}</details>`;
    };
    return head + c.list('itinerary.weeks', 'div', 'pdp-weeks', body, 'div', 'pdp-week') +
      (weeks.length || c.ed ? c.t('itinerary.note', 'p', 'pdp-small') : '');
  },
  day(p, c) {
    return `<h2 class="pdp-h2">${c.t('day.heading', 'span')}</h2>` +
      c.list('day.slots', 'ol', 'pdp-day', (it, ip) => `${c.t(`${ip}.time`, 'span', 'pdp-day__time')}${c.t(`${ip}.text`, 'span', '')}`, 'li', 'pdp-day__slot') +
      c.list('day.notes', 'div', 'pdp-grid pdp-grid--3', (it, ip) => `${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.body`, 'p', 'pdp-muted', { multiline: true })}`, 'div', 'pdp-card pdp-card--pad');
  },
  stay(p, c) {
    return `<h2 class="pdp-h2">${c.t('stay.heading', 'span')}</h2>${c.t('stay.intro', 'p', 'pdp-lede', { multiline: true })}` +
      c.list('stay.items', 'div', 'pdp-grid pdp-grid--4', (it, ip) =>
        `${c.img(`${ip}.image`, `${ip}.imageAlt`, 'pdp-card__img')}<div class="pdp-card__body">${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.body`, 'p', 'pdp-muted', { multiline: true })}</div>`,
        'article', 'pdp-card');
  },
  learning(p, c) {
    return `<h2 class="pdp-h2">${c.t('learning.heading', 'span')}</h2>` +
      c.list('learning.items', 'div', 'pdp-grid pdp-grid--2', (it, ip) =>
        `${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.body`, 'p', 'pdp-muted', { multiline: true })}` +
        (it.linkText || c.ed ? c.link(`${ip}.linkText`, it.linkUrl, 'pdp-link', `${ip}.linkUrl`) : ''),
        'div', 'pdp-card pdp-card--pad');
  },
  instructors(p, c) {
    return `<h2 class="pdp-h2">${c.t('instructors.heading', 'span')}</h2>${c.t('instructors.intro', 'p', 'pdp-lede', { multiline: true })}` +
      c.list('instructors.people', 'div', 'pdp-grid pdp-grid--3', (it, ip) =>
        `${c.img(`${ip}.photo`, null, 'pdp-person__img', 'Photo')}<div>${c.t(`${ip}.name`, 'h3', 'pdp-h3')}${c.t(`${ip}.role`, 'p', 'pdp-person__role')}${c.t(`${ip}.bio`, 'p', 'pdp-muted', { multiline: true })}</div>`,
        'div', 'pdp-person');
  },
  safety(p, c) {
    return `<h2 class="pdp-h2">${c.t('safety.heading', 'span')}</h2>` +
      c.list('safety.items', 'div', 'pdp-grid pdp-grid--4', (it, ip) => `${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.body`, 'p', 'pdp-muted', { multiline: true })}`, 'div', 'pdp-card pdp-card--pad') +
      (p.safety.linkText || c.ed ? `<p>${c.link('safety.linkText', p.safety.linkUrl, 'pdp-link', 'safety.linkUrl')}</p>` : '');
  },
  cost(p, c) {
    const f = p.facts;
    const lines = c.list('cost.lines', 'div', 'pdp-cost__lines', (it, ip) => `${c.t(`${ip}.label`, 'span', '')}${c.t(`${ip}.amount`, 'strong', '')}`, 'div', 'pdp-cost__row');
    const pr = activePromo(p);
    const charged = pr && !pr.expired && pr.price ? pr.price : Number(f.tuition);
    const weekly = charged > 0 && Number(f.weeks) > 0 ? Math.round(charged / Number(f.weeks) / 10) * 10 : 0;
    return `<h2 class="pdp-h2">${c.t('cost.heading', 'span')}</h2>` +
      `<div class="pdp-split">` +
      `<div class="pdp-card pdp-card--pad pdp-cost">` +
      `<div class="pdp-cost__row pdp-cost__row--lead"><span>Program tuition</span><span class="pdp-cost__price">${renderPrice(p, c)}</span></div>` +
      (Number(f.flightsEstimate) > 0 || c.ed ? `<div class="pdp-cost__row"><span>Flights (estimate)</span>${c.v('facts.flightsEstimate', money(f.flightsEstimate, c.cur) ? `~${money(f.flightsEstimate, c.cur)}` : 'Set estimate', 'strong')}</div>` : '') +
      lines +
      (weekly ? `<p class="pdp-small">That’s about ${esc(money(weekly, c.cur))} per week of tuition.</p>` : '') +
      c.t('cost.note', 'p', 'pdp-small', { multiline: true }) +
      `</div>` +
      `<div class="pdp-incl">` +
      `<div class="pdp-card pdp-card--pad"><h3 class="pdp-h3">Included</h3>${c.list('cost.included', 'ul', 'pdp-ticks', (it, ip) => c.t(`${ip}.text`, 'span', ''), 'li', '')}</div>` +
      `<div class="pdp-card pdp-card--pad"><h3 class="pdp-h3">Not included</h3>${c.list('cost.excluded', 'ul', 'pdp-ticks pdp-ticks--x', (it, ip) => c.t(`${ip}.text`, 'span', ''), 'li', '')}</div>` +
      `</div></div>`;
  },
  reviews(p, c) {
    const vid = videoEmbed(p.reviews.videoUrl);
    return `<h2 class="pdp-h2">${c.t('reviews.heading', 'span')}</h2>` +
      renderWidgets(p, c, 'reviews.widgets', 'pdp-widgets-wrap pdp-widgets-wrap--reviews') +
      (vid ? `<div class="pdp-video"${c.ed ? ' data-v="reviews.videoUrl"' : ''}><iframe src="${attr(vid)}" title="Student video" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : '') +
      reviewWall(p, c);
  },
  dates(p, c) {
    const today = new Date().toISOString().slice(0, 10);
    return `<h2 class="pdp-h2">${c.t('dates.heading', 'span')}</h2>` +
      c.list('dates.sessions', 'div', 'pdp-dates', (s, ip) => {
        // Sessions that have already started drop off the live page (nightly rebuild).
        if (!c.ed && s.start && s.start < today) return null;
        const closed = /^(full|closed)$/i.test(s.status || '');
        const label = s.spotsLeft !== '' && s.spotsLeft != null && Number(s.spotsLeft) > 0 && !closed
          ? `${s.status || 'Open'} · ${Number(s.spotsLeft)} spot${Number(s.spotsLeft) === 1 ? '' : 's'} left` : (s.status || 'Open');
        const href = s.applyUrl || p.settings.applyUrl;
        return `<div class="pdp-date__when">${c.v(`${ip}.start`, dateRange(s.start, s.end) || 'Set dates', 'strong')}${c.v(`${ip}.season`, s.season || '', 'span', 'pdp-muted')}</div>` +
          `${c.v(`${ip}.status`, label, 'span', `pdp-pill pdp-pill--${closed ? 'closed' : /limited|waitlist/i.test(s.status || '') ? 'limited' : 'open'}`)}` +
          (closed ? `<span class="pdp-btn pdp-btn--disabled" aria-disabled="true">${esc(s.status)}</span>`
            : `<a class="pdp-btn" href="${attr(safeUrl(href))}">Apply</a>`);
      }, 'div', 'pdp-date') +
      (p.dates.help || c.ed ? `<p class="pdp-small">${c.t('dates.help', 'span', '')}${helpLinks(p)}</p>` : '');
  },
  faq(p, c) {
    return `<h2 class="pdp-h2">${c.t('faq.heading', 'span')}</h2>` +
      c.list('faq.items', 'div', 'pdp-faq', (it, ip) => c.ed
        ? `<div class="pdp-faq__q">${c.t(`${ip}.q`, 'span', '')}</div>${c.t(`${ip}.a`, 'p', 'pdp-faq__a', { multiline: true })}`
        : `<details><summary class="pdp-faq__q"><span>${esc(it.q)}</span><span class="pdp-chev" aria-hidden="true"></span></summary><p class="pdp-faq__a pdp-ml">${esc(it.a)}</p></details>`,
      'div', 'pdp-faq__item');
  },
  cta(p, c) {
    return `<div class="pdp-cta"><div>${c.t('cta.heading', 'h2', 'pdp-h2 pdp-h2--inv')}${c.t('cta.body', 'p', '')}</div>` +
      `<div class="pdp-cta__btns">${c.link('cta.primaryText', p.settings.applyUrl, 'pdp-btn pdp-btn--inv', 'settings.applyUrl')}` +
      (p.cta.secondaryText || c.ed ? c.link('cta.secondaryText', p.settings.callUrl || p.settings.bookletUrl, 'pdp-btn pdp-btn--inv-ghost', p.settings.callUrl ? 'settings.callUrl' : 'settings.bookletUrl') : '') +
      `</div></div>`;
  },
  related(p, c) {
    return `<h2 class="pdp-h2">${c.t('related.heading', 'span')}</h2>` +
      c.list('related.items', 'div', 'pdp-grid pdp-grid--3', (it, ip) => {
        const inner = `${c.img(`${ip}.image`, null, 'pdp-card__img')}<div class="pdp-card__body">${c.t(`${ip}.title`, 'h3', 'pdp-h3')}${c.t(`${ip}.meta`, 'p', 'pdp-muted')}</div>`;
        return c.ed ? inner : `<a class="pdp-card__link" href="${attr(safeUrl(it.url))}">${inner}</a>`;
      }, 'article', 'pdp-card');
  },
};

function helpLinks(p) {
  const out = [];
  if (p.settings.callUrl) out.push(`<a class="pdp-link" href="${attr(safeUrl(p.settings.callUrl))}">Book a call</a>`);
  if (p.settings.whatsappUrl) out.push(`<a class="pdp-link" href="${attr(safeUrl(p.settings.whatsappUrl))}">Message us on WhatsApp</a>`);
  return out.length ? ` ${out.join(' · ')}` : '';
}

export function videoEmbed(u) {
  const s = String(u || '');
  let m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/.exec(s);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = /vimeo\.com\/(?:video\/)?(\d+)/.exec(s);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return '';
}

/** "4.5" → 4.5 out of 5; "98%" → 98 out of 100. Returns null if it isn't a number. */
export function parseScore(score) {
  const s = String(score ?? '').trim();
  const pct = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) { const v = Math.min(100, Number(pct[1])); return { value: v, max: 100, pct: v }; }
  const m = /^(\d(?:\.\d+)?)(?:\s*\/\s*5)?$/.exec(s);
  if (m) { const v = Math.min(5, Number(m[1])); return { value: v, max: 5, pct: (v / 5) * 100 }; }
  return null;
}

function renderWidgets(p, c, path = 'hero.widgets', wrap = 'pdp-widgets-wrap') {
  const items = getPath(p, path) || [];
  if (!items.length && !c.ed) return '';
  const html = c.list(path, 'ul', 'pdp-widgets', (w) => {
    const pw = parseWidget(w);
    const note = (txt, bad) => `<span class="pdp-widget pdp-widget--note${bad ? ' pdp-widget--bad' : ''}">${esc(txt)}</span>`;
    if (!pw) return c.ed ? note(w.code ? `This ${w.type || ''} code isn't recognised. Paste the embed code again.` : `Paste the ${w.type || ''} embed code in the panel →`, !!w.code) : null;
    if (pw.kind === 'goabroad') {
      const frame = `<iframe class="pdp-widget__frame" src="${esc(pw.src)}" width="${pw.width}" height="${pw.height}" title="GoAbroad reviews" loading="lazy" scrolling="no" style="width:${pw.width}px;height:${pw.height}px"></iframe>`;
      // In the editor a cover sits over the frame so a click selects the widget.
      return `<span class="pdp-widget pdp-widget--frame">${frame}${c.ed ? '<span class="pde-cover"></span>' : ''}</span>`;
    }
    if (pw.kind === 'gooverseas') {
      if (c.ed) return note(`GoOverseas reviews widget #${pw.id} — shows on the live page`);
      return `<span class="pdp-widget pdp-widget--gooverseas"><span class="go-overseas-review-widget-component widget-${esc(pw.name)}" data-gooverseas-widget-type="${esc(pw.wtype)}" data-gooverseas-widget-id="${esc(pw.id)}" data-gooverseas-widget-name="${esc(pw.name)}" data-gooverseas-widget-theme="${esc(pw.theme)}" data-gooverseas-widget-link="${esc(pw.link)}"></span></span>`;
    }
    // Google: the build fetches rating + count from the Places API (w._google).
    const g = w._google;
    if (!g || !(Number(g.rating) > 0)) return c.ed ? note('Google rating — filled in automatically when published') : null;
    const rating = Math.round(Number(g.rating) * 10) / 10;
    const count = Number(g.count) > 0 ? Number(g.count).toLocaleString('en-US') : '';
    const inner = `<span class="pdp-review__score">${esc(rating)}</span>` +
      `<span class="pdp-stars" aria-hidden="true"><span class="pdp-stars__fill" style="width:${Math.round((rating / 5) * 100)}%"></span></span>` +
      `<span class="pdp-review__meta">${count ? `<span>${esc(count)} reviews</span>` : ''}<span class="pdp-review__site">on Google</span></span>` +
      `<span class="pdp-sr">${esc(`${rating} out of 5${count ? ` from ${count} reviews` : ''} on Google`)}</span>`;
    return g.url && !c.ed ? `<a class="pdp-review" href="${esc(safeUrl(g.url))}" target="_blank" rel="noopener">${inner}</a>` : `<span class="pdp-review">${inner}</span>`;
  }, 'li', 'pdp-widgets__item');
  // Live page: nothing at all when no widget produced output (e.g. Google not fetched).
  if (!c.ed && !html.includes('<li')) return '';
  return `<div class="${wrap}">${html}</div>`;
}

const LAUREL = (flip) => `<svg class="pdp-award__laurel${flip ? ' pdp-award__laurel--r' : ''}" viewBox="0 0 40 96" aria-hidden="true" focusable="false"><path d="M30 92C14 78 8 58 10 36 11 24 15 13 22 4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>` +
  [[13, 80, -50], [9, 66, -35], [8, 51, -20], [9, 37, -8], [13, 23, 8], [19, 11, 22]].map(([x, y, r]) =>
    `<ellipse cx="${x}" cy="${y}" rx="4" ry="9" transform="rotate(${r} ${x} ${y})" fill="currentColor"/><ellipse cx="${x + 9}" cy="${y + 3}" rx="3.6" ry="8" transform="rotate(${r + 55} ${x + 9} ${y + 3})" fill="currentColor"/>`).join('') + `</svg>`;

function initials(name) {
  const words = String(name || '').replace(/,.*$/, '').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '').slice(0, 1)).toUpperCase();
}

/** Review wall: a bordered grid of review cards and award cards, with a “more” button. */
function reviewWall(p, c) {
  const limit = Math.max(0, Number(p.reviews.visible) || 0);
  let n = 0;
  let hidden = 0;
  const grid = c.list('reviews.quotes', 'div', 'pdp-wall', (it, ip, i) => {
    const award = it.kind === 'Award';
    if (!c.ed && (award ? !(it.awardTitle || it.badge) : !stripQuotes(it.quote))) return null;
    const extra = !c.ed && limit > 0 && n >= limit;
    n++;
    if (extra) hidden++;
    const cls = `pdp-card-${award ? 'award' : 'rev'}${extra ? ' is-extra' : ''}`;
    if (award) {
      // Images are added from the side panel, so empty ones show nothing here.
      const badge = it.badge ? c.img(`${ip}.badge`, `${ip}.badgeAlt`, 'pdp-award__badge') : '';
      const body = `<span class="pdp-award__label">${c.t(`${ip}.awardLabel`, 'span', '')}</span>` +
        `<strong class="pdp-award__title">${c.t(`${ip}.awardTitle`, 'span', '')}</strong>` +
        `<span class="pdp-award__text">${c.t(`${ip}.awardText`, 'span', '')}</span>`;
      const inner = it.badge
        ? `<div class="pdp-award pdp-award--badge ${cls}">${badge}${body}</div>`
        : `<div class="pdp-award ${cls}">${LAUREL(false)}<div class="pdp-award__core">${body}</div>${LAUREL(true)}</div>`;
      return !c.ed && it.url ? `<a class="pdp-wall__link" href="${attr(safeUrl(it.url))}" target="_blank" rel="noopener">${inner}</a>` : inner;
    }
    const q = stripQuotes(it.quote);
    const long = !c.ed && q.length > READ_MORE_AT;
    const tid = `pdp-rm-${i}`;
    const text = c.ed ? c.t(`${ip}.quote`, 'p', 'pdp-rev__text', { multiline: true })
      : `<p class="pdp-rev__text pdp-ml${long ? ' is-clamped' : ''}">${esc(q)}</p>`;
    const toggle = long ? `<input type="checkbox" id="${tid}" class="pdp-rev__t"><label for="${tid}" class="pdp-rev__more"><span>Read more</span><span>Show less</span></label>` : '';
    const photo = it.photo ? c.img(`${ip}.photo`, null, 'pdp-rev__photo') : '';
    const avatar = it.photo ? photo : `<span class="pdp-rev__initials" aria-hidden="true">${esc(initials(it.name)) || '•'}</span>`;
    const site = String(it.source || '').trim();
    const where = it.url && !c.ed
      ? `<a class="pdp-rev__src" href="${attr(safeUrl(it.url))}" target="_blank" rel="noopener">${site ? `View on ${esc(site)}` : 'View review'}</a>`
      : (site ? `<span class="pdp-rev__src">on ${esc(site)}</span>` : '');
    const detail = c.t(`${ip}.detail`, 'span', 'pdp-rev__detail');
    return `<figure class="pdp-rev ${cls}"><span class="pdp-rev__mark" aria-hidden="true">\u201C</span>` +
      `<div class="pdp-rev__main">${long ? toggle.replace(/<label[\s\S]*$/, '') : ''}<blockquote class="pdp-rev__q">${text}</blockquote>${long ? toggle.replace(/^<input[^>]*>/, '') : ''}` +
      `<figcaption class="pdp-rev__by"><span class="pdp-rev__who">${c.t(`${ip}.name`, 'strong', 'pdp-rev__name')}${detail}${where}</span>${avatar}</figcaption></div></figure>`;
  }, 'div', 'pdp-wall__item');
  if (!grid) return '';
  const more = hidden ? `<input type="checkbox" id="pdp-wall-more" class="pdp-wall__t"><label for="pdp-wall-more" class="pdp-wall__more">${esc(p.reviews.moreText || 'More reviews')}</label>` : '';
  // The toggle sits before the grid so CSS can reveal the extra cards.
  return `<div class="pdp-wall-wrap">${hidden ? more.replace(/<label[\s\S]*$/, '') : ''}${grid}${hidden ? more.replace(/^<input[^>]*>/, '') : ''}</div>`;
}

function renderReviews(p, c) {
  const items = p.hero.reviews || [];
  if (!items.length && !c.ed) return '';
  return `<div class="pdp-reviews-wrap">` + c.list('hero.reviews', 'ul', 'pdp-reviews', (r, ip) => {
    const sc = parseScore(r.score);
    const count = Number(r.count) > 0 ? Number(r.count).toLocaleString('en-US') : '';
    const site = r.source && r.source !== 'Other' ? r.source : '';
    const stars = sc && sc.max === 5
      ? `<span class="pdp-stars" aria-hidden="true"><span class="pdp-stars__fill" style="width:${sc.pct.toFixed(0)}%"></span></span>` : '';
    const scoreText = sc && sc.max === 100 ? `${sc.value}%` : (sc ? `${sc.value}` : String(r.score || ''));
    const label = sc ? (sc.max === 100 ? `${scoreText} rating` : `${scoreText} out of 5`) : scoreText;
    const inner =
      `<span class="pdp-review__score"${c.ed ? ` data-f="${esc(ip)}.score" data-empty="Score"` : ''}>${esc(c.ed ? (r.score ?? '') : scoreText)}</span>` +
      stars +
      `<span class="pdp-review__meta">` +
        `<span${c.ed ? ` data-v="${esc(ip)}.count"` : ''}>${count ? `${esc(count)} reviews` : (c.ed ? 'Set review count' : '')}</span>` +
        `<span class="pdp-review__site"${c.ed ? ` data-v="${esc(ip)}.source"` : ''}>${site ? `on ${esc(site)}` : (c.ed ? 'Choose site' : '')}</span>` +
      `</span>` +
      `<span class="pdp-sr">${esc(`${label}${count ? ` from ${count} reviews` : ''}${site ? ` on ${site}` : ''}`)}</span>`;
    return !c.ed && r.url
      ? `<a class="pdp-review" href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${inner}</a>`
      : `<span class="pdp-review">${inner}</span>`;
  }, 'li', 'pdp-reviews__item') + `</div>`;
}

/**
 * The soonest session that hasn't started yet and isn't full/closed.
 * `today` is YYYY-MM-DD; pages are rebuilt nightly so a past date drops off.
 */
/**
 * The promotion to show, or null. A promotional price only counts when it is
 * below tuition; the message works on its own. Ends after promoEnds (inclusive).
 */
export function activePromo(p, today = new Date().toISOString().slice(0, 10)) {
  const f = p?.facts || {};
  const tuition = Number(f.tuition) || 0;
  const price = Number(f.promoPrice) > 0 && Number(f.promoPrice) < tuition ? Number(f.promoPrice) : 0;
  const text = String(f.promoText || '').trim();
  if (!price && !text) return null;
  const ends = /^\d{4}-\d{2}-\d{2}$/.test(f.promoEnds || '') ? f.promoEnds : '';
  return { price, text, ends, expired: !!ends && ends < today };
}

export function nextSession(p, today = new Date().toISOString().slice(0, 10)) {
  const list = (p?.dates?.sessions || [])
    .map((s, i) => ({ ...s, _i: i }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.start || '') && s.start >= today && !/^(full|closed)$/i.test(s.status || ''));
  list.sort((a, b) => a.start.localeCompare(b.start));
  return list[0] || null;
}

function renderNext(p, c) {
  const n = nextSession(p);
  if (!n) {
    return c.ed ? `<span class="pdp-next pdp-next--empty"><span class="pdp-next__label">Next departure</span><span class="pdp-next__when">Add a start date</span></span>` : '';
  }
  const spots = Number(n.spotsLeft) > 0 ? Number(n.spotsLeft) : 0;
  const status = spots ? `${spots} spot${spots === 1 ? '' : 's'} left` : (/limited|waitlist/i.test(n.status || '') ? n.status : '');
  const ref = c.ed ? ` data-ref-item="dates.sessions.${n._i}"` : '';
  const inner =
    `<span class="pdp-next__label">Next departure</span>` +
    `<span class="pdp-next__when">${esc(shortDate(n.start).replace(/^(\w+) (\d+), (\d+)$/, '$2 $1 $3'))}</span>` +
    (status ? `<span class="pdp-pill pdp-next__pill">${esc(status)}</span>` : '');
  // Goes straight to the application, using this session's apply link if it has one.
  const href = safeUrl(n.applyUrl || p.settings.applyUrl);
  return c.ed ? `<span class="pdp-next"${ref}>${inner}</span>`
    : `<a class="pdp-next" href="${esc(href)}" aria-label="${esc(`Apply for the ${dateRange(n.start, n.end)} departure`)}">${inner}</a>`;
}

// Tuition with an optional promotion: normal price struck through, sale price
// in orange, and the promo message as a small badge. Expired promos vanish on
// the live page; the editor keeps them visible with a note.
function renderPrice(p, c, tag = 'strong') {
  const f = p.facts;
  const pr = activePromo(p);
  const base = money(f.tuition, c.cur);
  if (!pr || (pr.expired && !c.ed)) return c.v('facts.tuition', base || 'Set tuition', tag);
  const now = pr.price ? money(pr.price, c.cur) : '';
  const price = now
    ? `<span class="pdp-price"><s class="pdp-price__was"${c.ed ? ' data-v="facts.tuition"' : ''}><span class="pdp-sr">Was </span>${esc(base)}</s> ${c.ed ? `<${tag} class="pdp-price__now" data-v="facts.promoPrice">` : `<${tag} class="pdp-price__now">`}<span class="pdp-sr">now </span>${esc(now)}</${tag}></span>`
    : c.v('facts.tuition', base || 'Set tuition', tag);
  const note = pr.text ? `<span class="pdp-promo"${c.ed ? ' data-v="facts.promoText"' : ''}>${esc(pr.text)}</span>` : '';
  const ended = c.ed && pr.expired ? `<span class="pdp-promo pdp-promo--ended" data-v="facts.promoEnds">Promotion ended ${esc(shortDate(pr.ends))} · hidden on the live page</span>` : '';
  return price + note + ended;
}

function renderHero(p, c) {
  const f = p.facts;
  const fact = (label, html) => `<div class="pdp-fact"><span class="pdp-fact__label">${label}</span>${html}</div>`;
  const fd = parseFocus(p.hero.imageFocus), fm = parseFocus(p.hero.imageFocusMobile);
  const focus = fd || fm ? ` style="${fd ? `--pdp-pos:${fd};` : ''}${fm ? `--pdp-pos-m:${fm};` : ''}"` : '';
  const bg = p.hero.image
    ? `<div class="pdp-hero__media"${focus}>${c.img('hero.image', 'hero.imageAlt', 'pdp-hero__img')}</div>`
    : (c.ed ? `<div class="pdp-hero__media">${c.img('hero.image', 'hero.imageAlt', 'pdp-hero__img', 'Add a hero photo')}</div>` : '');
  return `<header class="pdp-hero${p.hero.image ? ' pdp-hero--img' : ''}">${bg}` +
    `<div class="pdp-wrap pdp-hero__inner">` +
    `${c.t('hero.eyebrow', 'p', 'pdp-eyebrow')}` +
    `${c.t('hero.headline', 'h1', 'pdp-h1', { multiline: true, keep: true })}` +
    `${c.t('hero.intro', 'p', 'pdp-hero__intro', { multiline: true })}` +
    `<div class="pdp-hero__ctas"><a class="pdp-btn pdp-btn--lg" href="#dates">Check dates &amp; apply</a>` +
    (p.settings.bookletUrl ? `<a class="pdp-btn pdp-btn--lg pdp-btn--inv-ghost" href="${attr(safeUrl(p.settings.bookletUrl))}">Get the itinerary</a>` : '') + `</div>` +
    renderWidgets(p, c) +
    renderReviews(p, c) +
    `</div></header>` +
    `<div class="pdp-wrap"><div class="pdp-facts"${c.ed ? ' data-group="facts"' : ''}>` +
    fact('Where', c.t('facts.countries', 'strong', '')) +
    fact('Length', c.v('facts.weeks', f.weeks ? `${f.weeks} weeks` : '—', 'strong')) +
    fact('Group', c.v('facts.groupMax', `${f.groupMax ? `Max ${f.groupMax}` : ''}${f.groupMax && f.ages ? ' · ' : ''}${f.ages ? `ages ${String(f.ages).replace(/[-–]/g, '\u2011')}` : ''}` || '—', 'strong')) +
    fact('Tuition', `${renderPrice(p, c)}${Number(f.flightsEstimate) > 0 ? `<span class="pdp-fact__sub">+ flights est. ${esc(money(f.flightsEstimate, c.cur))}</span>` : ''}`) +
    fact('Activity', c.v('facts.activityLevel', f.activityLevel || '—', 'strong')) +
    fact('College credit', c.t('facts.credit', 'strong', '')) +
    `</div></div>`;
}

function renderBar(p, c, shown) {
  const navs = shown.filter((k) => SECTION_BY_KEY[k].nav)
    .map((k) => `<a href="#${SECTION_BY_KEY[k].anchor}">${esc(SECTION_BY_KEY[k].nav)}</a>`).join('');
  return `<nav class="pdp-bar" aria-label="Program sections"><div class="pdp-wrap pdp-bar__inner">` +
    `<div class="pdp-bar__nav"><strong>${esc(p.name)}</strong>${navs}</div>` +
    `<div class="pdp-bar__cta">${renderNext(p, c)}<a class="pdp-btn" href="${attr(safeUrl(p.settings.applyUrl))}">Apply now</a></div>` +
    `</div></nav>`;
}

/**
 * The page body: everything that replaces <main> on pacificdiscovery.org.
 * @param {object} program
 * @param {{editable?: boolean}} [opts]
 */
export function renderProgram(program, opts = {}) {
  const p = normalizeProgram(program);
  const c = ctx(p, opts);
  const shown = p.layout.filter((l) => l.show).map((l) => l.key);
  const order = c.ed ? p.layout.map((l) => l.key) : shown;
  const secs = order.map((key) => {
    const meta = SECTION_BY_KEY[key];
    const hidden = !p.layout.find((l) => l.key === key)?.show;
    const inner = R[key](p, c);
    const tone = key === 'cta' ? ' pdp-sec--flush' : '';
    return `<section id="${meta.anchor}" class="pdp-sec${tone}${hidden ? ' pde-hidden' : ''}"${c.ed ? ` data-sec="${key}" data-label="${attr(meta.label)}"` : ''}><div class="pdp-wrap">${inner}</div></section>`;
  }).join('');
  const goScript = !c.ed && [...(p.hero.widgets || []), ...(p.reviews.widgets || [])].some((w) => parseWidget(w)?.kind === 'gooverseas')
    ? `<script>${GOOVERSEAS_LOADER}</script>` : '';
  return `<div class="pdp${c.ed ? ' pdp--edit' : ''}">${renderHero(p, c)}${renderBar(p, c, shown)}${secs}${goScript}</div>`;
}

export function seoFor(program, { canonicalBase = 'https://www.pacificdiscovery.org/programs/', slug = '' } = {}) {
  const p = normalizeProgram(program);
  return {
    title: p.seo.title || `${p.name} | Pacific Discovery`,
    description: p.seo.description || String(p.hero.intro || '').slice(0, 160),
    canonical: slug ? `${canonicalBase}${slug}` : '',
    ogImage: p.seo.ogImage || p.hero.image || '',
  };
}

/** schema.org data so search engines understand price, dates and length. */
export function jsonLd(program, { slug = '', canonicalBase = 'https://www.pacificdiscovery.org/programs/' } = {}) {
  const p = normalizeProgram(program);
  const s = seoFor(p, { slug, canonicalBase });
  const promo = activePromo(p);
  if (promo && promo.expired) promo.price = 0;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    name: p.name,
    description: s.description,
    url: s.canonical || undefined,
    image: s.ogImage || undefined,
    touristType: 'Gap year students aged ' + (p.facts.ages || '17–22'),
    provider: { '@type': 'Organization', name: 'Pacific Discovery', url: 'https://www.pacificdiscovery.org' },
    offers: (p.dates.sessions || []).filter((x) => x.start).map((x) => ({
      '@type': 'Offer',
      price: (promo && promo.price) || Number(p.facts.tuition) || undefined,
      priceValidUntil: (promo && promo.price && promo.ends) || undefined,
      priceCurrency: p.settings.currency || 'USD',
      availability: /^(full|closed)$/i.test(x.status || '') ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      url: safeUrl(x.applyUrl || p.settings.applyUrl),
      availabilityStarts: x.start,
      availabilityEnds: x.end || undefined,
    })),
  };
  // Escape "<" so a value can never close the <script> tag it sits in.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** A complete HTML document: the direct /p/<slug> view and the editor preview. */
export function renderStandalone(program, { slug = '', editable = false, extraHead = '', noindex = true } = {}) {
  const s = seoFor(program, { slug });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(s.title)}</title><meta name="description" content="${attr(s.description)}">` +
    (s.canonical ? `<link rel="canonical" href="${attr(s.canonical)}">` : '') +
    (noindex ? `<meta name="robots" content="noindex">` : '') +
    (s.ogImage ? `<meta property="og:image" content="${attr(safeUrl(s.ogImage))}">` : '') +
    `<meta property="og:title" content="${attr(s.title)}">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">` +
    `<style>body{margin:0;background:#fff}${PROGRAM_CSS}</style>${extraHead}</head><body>` +
    `<div id="pdp-root">${renderProgram(program, { editable })}</div>` +
    (editable ? '' : `<script type="application/ld+json">${jsonLd(program, { slug })}</script>`) +
    `</body></html>`;
}

// ─── styles ─────────────────────────────────────────────────────────────────
// Pacific Discovery tokens: topaz #55bbd2, topaz-dark #288195 (AA on white),
// green #81c243, ink #4a4a4a. Poppins body, DM Serif Display headings — both
// already loaded on pacificdiscovery.org.

export const PROGRAM_CSS = `
.pdp{--pdp-topaz:#55bbd2;--pdp-topaz-dk:#1f6b7c;--pdp-teal:#288195;--pdp-green:#81c243;--pdp-ink:#2f2f2f;--pdp-body:#4a4a4a;--pdp-muted:#5b6166;--pdp-line:#dfe5e8;--pdp-soft:#f3f8f9;--pdp-sand:#faf7f2;--pdp-orange:#F15B39;--pdp-orange-dk:#d9472a;--pdp-sticky-top:0px;
  font-family:Poppins,system-ui,sans-serif;color:var(--pdp-body);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;text-align:left}
.pdp *,.pdp *::before,.pdp *::after{box-sizing:border-box}
.pdp :where(h1,h2,h3,p,ul,ol,li,figure,blockquote){margin:0;padding:0}
.pdp :where(ul,ol){list-style:none}
/* Out-shout the host site's element styles (Bootstrap + main.css set p/h3/li sizes and fonts). */
.pdp :where(h1,h2,h3,h4,p,li,a,span,strong,blockquote,summary,footer){font-family:inherit;font-size:inherit;line-height:inherit;letter-spacing:normal;text-transform:none}
.pdp :where(p,li){color:inherit}
.pdp img{max-width:100%;display:block}
.pdp a{color:var(--pdp-teal)}
.pdp-ml{white-space:pre-line}
.pdp-wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.pdp-sec{padding:64px 0;border-top:1px solid var(--pdp-line)}
.pdp-sec:nth-of-type(even){background:var(--pdp-soft)}
.pdp-sec--flush{border-top:0;background:transparent!important;padding:24px 0 64px}
.pdp-sec .pdp-wrap{display:flex;flex-direction:column;gap:28px}
.pdp-h1{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:clamp(36px,5.2vw,60px);line-height:1.05;color:#fff;max-width:16ch}
.pdp-h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:clamp(28px,3.4vw,40px);line-height:1.15;color:var(--pdp-ink)}
.pdp-h2--inv{color:#fff}
.pdp-h3{font-family:Poppins,system-ui,sans-serif;font-size:18px;font-weight:600;line-height:1.35;color:var(--pdp-ink)}
.pdp-lede{font-size:18px;max-width:70ch;margin-top:-12px}
.pdp-muted{color:var(--pdp-muted)}
.pdp-small{font-size:14px;color:var(--pdp-muted)}
.pdp-eyebrow{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#fff}
.pdp-link{font-weight:600;text-decoration:underline;text-underline-offset:3px}
.pdp-btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;background:var(--pdp-teal);color:#fff!important;font-weight:600;font-size:15px;text-decoration:none!important;border:2px solid var(--pdp-teal);transition:background .15s,border-color .15s;white-space:nowrap}
.pdp-btn:hover{background:var(--pdp-topaz-dk);border-color:var(--pdp-topaz-dk)}
.pdp-btn--lg{min-height:52px;padding:0 28px;font-size:16px}
.pdp-btn--ghost{background:transparent;color:var(--pdp-teal)!important}
.pdp-btn--ghost:hover{background:var(--pdp-soft)}
.pdp-btn--inv{background:#fff;border-color:#fff;color:var(--pdp-ink)!important}
.pdp-btn--inv:hover{background:#eef6f8;border-color:#eef6f8}
.pdp-btn--inv-ghost{background:transparent;border-color:#fff;color:#fff!important}
.pdp-btn--inv-ghost:hover{background:rgba(255,255,255,.12);border-color:#fff}
.pdp-btn--disabled{background:#e9ecee;border-color:#e9ecee;color:#5b6166!important;cursor:not-allowed}
/* hero */
.pdp-hero{position:relative;background:var(--pdp-teal);color:#fff;min-height:520px;display:flex;align-items:flex-end;overflow:hidden}
.pdp-hero__media{position:absolute;inset:0}
.pdp-hero__img{width:100%;height:100%;object-fit:cover;object-position:var(--pdp-pos,50% 50%)}
.pdp-hero--img::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,22,28,.78) 0%,rgba(8,22,28,.45) 45%,rgba(8,22,28,.05) 75%),linear-gradient(180deg,rgba(8,22,28,0) 50%,rgba(8,22,28,.55) 100%);pointer-events:none}
.pdp-hero--img .pdp-hero__inner{text-shadow:0 1px 12px rgba(0,0,0,.35)}
.pdp-hero__inner{position:relative;z-index:1;width:100%;padding-top:120px;padding-bottom:76px;display:flex;flex-direction:column;gap:18px}
.pdp-hero__intro{font-size:19px;max-width:58ch;color:#fff}
.pdp-hero__ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px}
.pdp-next{display:inline-flex;align-items:center;gap:10px;background:var(--pdp-orange);color:#fff!important;text-decoration:none!important;border-radius:999px;padding:6px 8px 6px 18px;min-height:46px;box-shadow:0 2px 10px rgba(241,91,57,.35);transition:background .15s}
a.pdp-next:hover{background:var(--pdp-orange-dk)}
a.pdp-next:focus-visible{outline:3px solid var(--pdp-ink);outline-offset:2px}
/* White on #F15B39 is 3.3:1: fine for the 19px bold date (large text), too faint
   for small text, so the label is near-black and the spots tag is white. */
.pdp-next__label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#1a1a1a;line-height:1.1;max-width:72px}
.pdp-next__when{font-size:19px;font-weight:700;line-height:1;color:#fff;white-space:nowrap}
.pdp-next__pill{background:#fff;color:#a8361a}
.pdp-next:not(:has(.pdp-next__pill)){padding-right:18px}
.pdp-next--empty{background:#eef0f1;box-shadow:none;padding-right:18px}
.pdp-next--empty .pdp-next__label{color:var(--pdp-muted)}
.pdp-next--empty .pdp-next__when{font-size:14px;font-weight:500;color:var(--pdp-muted)}
.pdp-widgets{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:4px}
.pdp-widgets-wrap--reviews{margin-bottom:24px}
.pdp-widgets-wrap--reviews .pdp-widgets{align-items:flex-start;gap:16px}
.pdp-widgets-wrap--reviews .pdp-widget{box-shadow:none;border:1px solid var(--pdp-line)}
.pdp-widgets-wrap--reviews .pdp-widget--gooverseas{min-width:min(100%,320px)}
.pdp-widgets-wrap .pde-add{max-width:320px;background:rgba(255,255,255,.9)}
.pdp-widget{position:relative;display:inline-flex;align-items:center;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.15);text-shadow:none;max-width:100%}
.pdp-widget__frame{border:0;display:block;max-width:100%}
.pdp-widget--gooverseas{min-height:84px;min-width:260px}
.pdp-widget--note{padding:12px 16px;font-size:13px;font-weight:500;color:var(--pdp-muted);border:2px dashed #c9d6da;background:rgba(255,255,255,.95);min-height:60px}
.pdp-widget--bad{border-color:#e3a08f;color:#a8361a}
.pde-cover{position:absolute;inset:0;cursor:pointer}
.pdp-reviews{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
.pdp-reviews-wrap .pde-add{max-width:320px;background:rgba(255,255,255,.9)}
.pdp-review{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.95);color:var(--pdp-ink)!important;text-decoration:none!important;border-radius:12px;padding:8px 14px;text-shadow:none;min-height:44px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
a.pdp-review:hover{background:#fff}
.pdp-review__score{font-size:20px;font-weight:700;line-height:1;color:var(--pdp-ink)}
.pdp-review__meta{display:flex;flex-direction:column;font-size:12px;line-height:1.3;color:var(--pdp-muted)}
.pdp-review__site{font-weight:600;color:var(--pdp-teal)}
.pdp-stars{position:relative;display:inline-block;font-size:16px;line-height:1;letter-spacing:1px;color:#d5d9dc}
.pdp-stars::before{content:"★★★★★"}
.pdp-stars__fill{position:absolute;inset:0 auto 0 0;overflow:hidden;white-space:nowrap;color:#e8a200}
.pdp-stars__fill::before{content:"★★★★★"}
.pdp-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pdp-facts{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));background:#fff;border:1px solid var(--pdp-line);border-radius:16px;margin-top:-36px;position:relative;z-index:2;box-shadow:0 8px 30px rgba(20,40,50,.08);overflow:hidden}
.pdp-fact{padding:18px 18px;border-right:1px solid var(--pdp-line);display:flex;flex-direction:column;gap:2px}
.pdp-fact:last-child{border-right:0}
.pdp-fact__label{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pdp-muted)}
.pdp-fact strong{color:var(--pdp-ink);font-size:16px;line-height:1.35}
.pdp-fact__sub{font-size:13px;color:var(--pdp-muted)}
.pdp-price{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px}
.pdp-price__was{color:var(--pdp-muted);font-weight:500;font-size:.82em;text-decoration-thickness:2px;text-decoration-color:var(--pdp-orange)}
.pdp-price__now{color:var(--pdp-orange-dk)}
.pdp-promo{display:inline-block;align-self:flex-start;margin:4px 0 2px;padding:3px 9px;border-radius:999px;background:#fdeae5;color:#a8361a;font-size:12px;font-weight:600;line-height:1.35}
.pdp-promo--ended{background:#eef1f2;color:var(--pdp-muted)}
.pdp-cost__price{display:flex;flex-direction:column;align-items:flex-end;text-align:right}
.pdp-cost__price .pdp-promo{align-self:flex-end}
/* sticky bar */
.pdp-bar{position:sticky;top:var(--pdp-sticky-top);z-index:20;background:rgba(255,255,255,.96);backdrop-filter:saturate(1.4) blur(6px);border-bottom:1px solid var(--pdp-line);margin-top:28px}
.pdp-bar__inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;flex-wrap:wrap;padding-top:8px;padding-bottom:8px}
.pdp-bar__nav{display:flex;gap:22px;align-items:center;flex-wrap:wrap;font-size:14px}
.pdp-bar__nav strong{color:var(--pdp-ink);font-size:15px}
.pdp-bar__nav a{color:var(--pdp-body);text-decoration:none;font-weight:500}
.pdp-bar__nav a:hover{color:var(--pdp-teal)}
.pdp-bar__cta{display:flex;gap:14px;align-items:center}
/* grids + cards */
.pdp-grid{display:grid;gap:20px}
.pdp-grid--2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.pdp-grid--3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.pdp-grid--4{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.pdp-card{background:#fff;border:1px solid var(--pdp-line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.pdp-card--pad{padding:22px;gap:8px}
.pdp-card__img{width:100%;aspect-ratio:4/3;object-fit:cover}
.pdp-card__body{padding:18px 20px 22px;display:flex;flex-direction:column;gap:8px}
.pdp-card__link{color:inherit!important;text-decoration:none!important;display:flex;flex-direction:column;height:100%}
.pdp-card__link:hover .pdp-h3{color:var(--pdp-teal)}
.pdp-split{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:28px;align-items:start}
.pdp-head-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.pdp-head-row>div{display:flex;flex-direction:column;gap:22px}
/* route */
.pdp-route-map__img{width:100%;border-radius:14px;border:1px solid var(--pdp-line);background:#fff}
.pdp-phases{display:flex;flex-direction:column;gap:10px;counter-reset:ph}
.pdp-phase{display:flex;gap:16px;align-items:baseline;background:#fff;border:1px solid var(--pdp-line);border-radius:12px;padding:14px 18px}
.pdp-phase__label{min-width:84px;color:var(--pdp-teal);font-weight:700}
/* itinerary */
.pdp-weeks{border:1px solid var(--pdp-line);border-radius:14px;overflow:hidden;background:#fff}
.pdp-week{border-top:1px solid var(--pdp-line)}
.pdp-week:first-child{border-top:0}
.pdp-week__sum{display:flex;align-items:baseline;gap:14px;padding:18px 22px;cursor:pointer;list-style:none;flex-wrap:wrap}
.pdp-week__sum::-webkit-details-marker{display:none}
.pdp-week__num{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--pdp-teal);min-width:62px}
.pdp-week__title{font-weight:600;color:var(--pdp-ink);font-size:17px;flex:1}
.pdp-week__loc{font-size:14px;color:var(--pdp-muted)}
.pdp-week__body{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:24px;padding:0 22px 22px 98px}
.pdp-week__img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px}
.pdp-chev{width:10px;height:10px;border-right:2px solid var(--pdp-muted);border-bottom:2px solid var(--pdp-muted);transform:rotate(45deg);margin-left:auto;align-self:center;transition:transform .2s}
details[open]>summary .pdp-chev{transform:rotate(-135deg)}
.pdp-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.pdp-tags li{font-size:13px;background:var(--pdp-soft);border:1px solid var(--pdp-line);border-radius:999px;padding:3px 12px}
/* day */
.pdp-day{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.pdp-day__slot{background:#fff;border:1px solid var(--pdp-line);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.pdp-day__time{font-weight:700;color:var(--pdp-teal);font-size:14px}
/* people */
.pdp-person{display:flex;gap:16px;align-items:flex-start;background:#fff;border:1px solid var(--pdp-line);border-radius:14px;padding:20px}
.pdp-person>div{display:flex;flex-direction:column;gap:6px}
.pdp-person__img{width:76px;height:76px;border-radius:50%;object-fit:cover;flex-shrink:0}
.pdp-person__role{font-size:14px;color:var(--pdp-teal);font-weight:600}
/* cost */
.pdp-cost{gap:0}
.pdp-cost__lines{display:flex;flex-direction:column}
.pdp-cost__row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--pdp-line)}
.pdp-cost__row strong{color:var(--pdp-ink)}
.pdp-cost__row--lead{font-size:18px}
.pdp-cost .pdp-small{padding-top:12px}
.pdp-incl{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.pdp-ticks{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.pdp-ticks li{position:relative;padding-left:26px}
.pdp-ticks li::before{content:"";position:absolute;left:2px;top:6px;width:7px;height:12px;border-right:2.5px solid #4f8a1f;border-bottom:2.5px solid #4f8a1f;transform:rotate(40deg)}
.pdp-ticks--x li::before{border:0;width:12px;height:12px;top:7px;left:0;transform:none;background:linear-gradient(45deg,transparent 44%,#b4442a 44%,#b4442a 56%,transparent 56%),linear-gradient(-45deg,transparent 44%,#b4442a 44%,#b4442a 56%,transparent 56%)}
/* reviews */
.pdp-video{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#000;max-width:860px}
.pdp-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.pdp-wall-wrap{display:flex;flex-direction:column;align-items:center;gap:22px}
.pdp-wall{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:#fff;border:1px solid var(--pdp-line);border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(31,107,124,.08)}
.pdp-wall__item{display:flex;min-width:0;margin:-1px 0 0 -1px;box-shadow:inset 1px 0 0 var(--pdp-line),inset 0 1px 0 var(--pdp-line)}
.pdp-wall__item>*{flex:1;min-width:0;margin:1px 0 0 1px}
.pdp-wall__item:has(>.is-extra),.pdp-wall__item:has(>a>.is-extra){display:none}
.pdp-wall__t:checked~.pdp-wall .pdp-wall__item{display:flex}
.pdp-wall__t,.pdp-rev__t{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.pdp-wall__more{display:inline-flex;align-items:center;gap:8px;padding:12px 26px;border-radius:999px;background:var(--pdp-orange);color:#fff;font-weight:600;font-size:15px;cursor:pointer;box-shadow:0 6px 16px rgba(241,91,57,.28);transition:background .15s}
.pdp-wall__more:hover{background:var(--pdp-orange-dk)}
.pdp-wall__t:focus-visible~.pdp-wall__more{outline:3px solid var(--pdp-topaz);outline-offset:3px}
.pdp-wall__t:checked~.pdp-wall__more{display:none}
.pdp-wall__link{display:flex;color:inherit;text-decoration:none}
.pdp-rev{display:flex;gap:12px;padding:26px 24px 22px 18px;margin:0}
.pdp-rev__mark{flex:none;font-family:'DM Serif Display',Georgia,serif;font-size:58px;line-height:.9;height:40px;color:var(--pdp-orange)}
.pdp-rev__main{flex:1;min-width:0;display:flex;flex-direction:column}
.pdp-rev__q{flex:1;margin:0}
.pdp-rev__text{font-size:15px;line-height:1.6;color:var(--pdp-body)}
.pdp-rev__text.is-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5;overflow:hidden}
.pdp-rev__t:checked~.pdp-rev__q .pdp-rev__text{display:block;-webkit-line-clamp:unset}
.pdp-rev__more{align-self:flex-start;margin-top:6px;font-size:13px;font-weight:600;color:var(--pdp-teal);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.pdp-rev__more span+span,.pdp-rev__t:checked~.pdp-rev__more span:first-child{display:none}
.pdp-rev__t:checked~.pdp-rev__more span+span{display:inline}
.pdp-rev__t:focus-visible~.pdp-rev__more{outline:2px solid var(--pdp-topaz);outline-offset:2px}
.pdp-rev__by{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:16px;text-align:right}
.pdp-rev__who{display:flex;flex-direction:column;align-items:flex-end;min-width:0}
.pdp-rev__name{font-weight:700;color:var(--pdp-ink);font-size:15px}
.pdp-rev__detail{font-size:13px;color:var(--pdp-muted)}
.pdp-rev__src{font-size:12px;color:var(--pdp-teal);text-decoration:none}
a.pdp-rev__src:hover{text-decoration:underline}
.pdp-rev__photo,.pdp-rev__initials{flex:none;width:44px;height:44px;border-radius:50%;object-fit:cover}
.pdp-rev__initials{display:inline-flex;align-items:center;justify-content:center;background:var(--pdp-soft);color:var(--pdp-teal);font-weight:700;font-size:15px;border:2px solid #fff;box-shadow:0 0 0 1px var(--pdp-line)}
.pdp-rev__photo.pdp-img--empty{display:inline-flex;align-items:center;justify-content:center;font-size:18px;min-height:0}
.pdp-award{display:flex;align-items:center;justify-content:center;gap:6px;padding:28px 18px;background:linear-gradient(180deg,#fff 0%,var(--pdp-soft) 100%);text-align:center}
.pdp-award__laurel{flex:none;width:34px;height:84px;color:#9aa7ad}
.pdp-award__laurel--r{transform:scaleX(-1)}
.pdp-award__core,.pdp-award--badge{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.pdp-award--badge{flex-direction:column}
.pdp-award__label,.pdp-award__label *{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pdp-teal)}
.pdp-award__title{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:28px;line-height:1.1;color:var(--pdp-ink)}
.pdp-award__text{font-size:13px;font-style:italic;color:var(--pdp-muted)}
.pdp-award__badge{max-width:120px;max-height:110px;width:auto;height:auto;object-fit:contain;margin-bottom:8px}
.pdp-award__badge.pdp-img--empty{width:120px;height:60px;font-size:12px}
/* dates */
.pdp-dates{display:flex;flex-direction:column;border:1px solid var(--pdp-line);border-radius:14px;background:#fff;overflow:hidden}
.pdp-date{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:16px;align-items:center;padding:16px 22px;border-top:1px solid var(--pdp-line)}
.pdp-date:first-child{border-top:0}
.pdp-date__when{display:flex;flex-direction:column}
.pdp-date__when strong{color:var(--pdp-ink);font-size:17px}
.pdp-pill{font-size:13px;font-weight:600;padding:4px 12px;border-radius:999px;white-space:nowrap}
.pdp-pill--open{background:#e9f5dd;color:#3c6b14}
.pdp-pill--limited{background:#fff1dc;color:#8a4b00}
.pdp-pill--closed{background:#eef0f1;color:#5b6166}
/* faq */
.pdp-faq{display:flex;flex-direction:column;border-top:1px solid var(--pdp-line)}
.pdp-faq__item{border-bottom:1px solid var(--pdp-line)}
.pdp-faq__q{display:flex;gap:16px;align-items:center;padding:18px 0;font-weight:600;color:var(--pdp-ink);cursor:pointer;list-style:none;font-size:17px}
.pdp-faq__q::-webkit-details-marker{display:none}
.pdp-faq__a{padding:0 0 20px;max-width:75ch}
/* closing cta */
.pdp-cta{background:var(--pdp-teal);color:#fff;border-radius:20px;padding:48px 44px;display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap}
.pdp-cta>div:first-child{display:flex;flex-direction:column;gap:8px;max-width:640px}
.pdp-cta__btns{display:flex;gap:12px;flex-wrap:wrap}
.pdp-img--empty{display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(45deg,#eef3f4,#eef3f4 10px,#e6eef0 10px,#e6eef0 20px);color:#5b6166;font-size:13px;font-weight:600;min-height:140px}
.pdp-hero__media .pdp-img--empty{height:100%;background:repeating-linear-gradient(45deg,#2b8798,#2b8798 14px,#2f8fa0 14px,#2f8fa0 28px);color:#e5f4f7}
.pdp-person .pdp-img--empty{width:76px;height:76px;min-height:0;border-radius:50%;flex-shrink:0}
@media (max-width:900px){.pdp-wall{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pdp-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pdp-fact{border-bottom:1px solid var(--pdp-line)}
  .pdp-fact:nth-child(2n){border-right:0}
  .pdp-week__body{grid-template-columns:1fr;padding:0 22px 22px}
  .pdp-bar__nav a{display:none}
}
@media (max-width:640px){.pdp-wall{grid-template-columns:1fr}
  .pdp-sec{padding:44px 0}
  .pdp-hero{min-height:460px}
  .pdp-hero__inner{padding-top:96px;padding-bottom:52px}
  .pdp-hero__intro{font-size:17px}
  .pdp-hero__img{object-position:var(--pdp-pos-m,var(--pdp-pos,50% 50%))}
  .pdp-date{grid-template-columns:1fr auto;padding:16px}
  .pdp-date .pdp-btn{grid-column:1/-1}
  .pdp-cta{padding:32px 24px}
  .pdp-split{grid-template-columns:1fr}
  .pdp-bar__inner{min-height:56px}
  .pdp-bar__nav{display:none}
  .pdp-bar__inner{justify-content:flex-end}
  .pdp-bar__cta{width:100%;justify-content:space-between;gap:8px}
  .pdp-next{min-height:44px;padding:5px 6px 5px 14px;gap:8px;display:inline-grid;grid-template-columns:auto auto;grid-template-rows:auto auto;column-gap:10px;row-gap:1px}
  .pdp-next__label{font-size:10px;max-width:none;grid-column:1;grid-row:1}
  .pdp-next__when{font-size:18px;grid-column:1;grid-row:2}
  .pdp-next__pill{grid-column:2;grid-row:1/3;align-self:center;font-size:12px;padding:3px 10px}
  .pdp-bar .pdp-btn{min-height:44px;padding:0 16px;font-size:14px}
}
`;
