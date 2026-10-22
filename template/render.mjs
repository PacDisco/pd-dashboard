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

function ctx(p, opts, schema = SCHEMA) {
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
    const add = ed ? `<button type="button" class="pde-add" data-add="${attr(path)}">+ ${esc(schema.lists[path]?.add || 'Add')}</button>` : '';
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
export function renderStandalone(program, { slug = '', editable = false, extraHead = '', noindex = true, canonicalBase } = {}) {
  if (templateOf(program) === 'landing') return renderLandingStandalone(program, { slug, editable, extraHead, noindex, canonicalBase });
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
.pdp .pdp-rev__q{flex:1;margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;max-width:none;width:auto;text-align:left;font-style:normal;font-size:inherit;quotes:none}
.pdp .pdp-rev__q::before,.pdp .pdp-rev__q::after{content:none;display:none}
.pdp .pdp-rev__q .pdp-rev__text{margin:0;padding:0;border:0;text-align:left;font-style:normal;max-width:none}
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

// ════════════════════════════════════════════════════════════════════════════
// LANDING PAGE TEMPLATE — "Why Pacific Discovery" style campaign pages
// ════════════════════════════════════════════════════════════════════════════
//
// A second template, edited in the same Program Pages editor. A page uses it
// when its JSON has `template: "landing"`. Landing pages are served at
// www.pacificdiscovery.org/lp/<slug> (the Cloudflare Worker swaps them into
// the site's <main>, keeping the real header and footer).
//
// Same rules as the program template: every value is escaped, every URL goes
// through safeUrl(), and all CSS is scoped under .pdl.

export const LANDING_BASE = '/lp/';

export const LANDING_SECTIONS = [
  { key: 'stats',   label: 'Stats strip',            anchor: 'stats',   bg: '#55bbd2' },
  { key: 'reasons', label: 'Reasons',                anchor: 'reasons', bg: '#ffffff' },
  { key: 'compare', label: 'Comparison table',       anchor: 'compare', bg: '#f1f1f1', wave: true },
  { key: 'week',    label: 'A week in the life',     anchor: 'week',    bg: '#fbfaf7' },
  { key: 'voices',  label: 'Quotes',                 anchor: 'voices',  bg: '#344f8d' },
  { key: 'ribbon',  label: 'Photo ribbon',           anchor: 'photos',  bg: '#212121' },
  { key: 'safety',  label: 'Safety',                 anchor: 'safety',  bg: '#ffffff' },
  { key: 'offer',   label: 'Pricing & offer',        anchor: 'offer',   bg: '#f1f1f1', wave: true },
  { key: 'faq',     label: 'FAQ',                    anchor: 'faq',     bg: '#ffffff' },
  { key: 'cta',     label: 'Closing call to action', anchor: 'get-started', bg: '#212121' },
];
const LSEC = Object.fromEntries(LANDING_SECTIONS.map((s) => [s.key, s]));

// Line icons for the reason cards (24×24, stroked). Names are what editors pick.
const ICONS = {
  Globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
  Calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  People: '<path d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M21 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  Shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  Award: '<circle cx="12" cy="8" r="5"/><path d="M8.5 12.5L7 21l5-3 5 3-1.5-8.5"/><path d="M10 8l1.5 1.5L14 7"/>',
  Mountain: '<path d="M3 20l6-12 4 7 3-4 5 9z"/><circle cx="17" cy="6" r="2"/>',
  Compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  Heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  Leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-4 6-7 10-9"/>',
  Home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  Book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
  Plane: '<path d="M10 14l-6-2 1-2 7 0 4-6h2l-2 6h4l1.5-2H23l-1 4-1 4h-1.5L18 14h-4l2 6h-2z"/>',
};
export const LANDING_ICONS = Object.keys(ICONS);
const icon = (name) => `<svg class="pdl-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.Globe}</svg>`;
// Wires the week section's arrow buttons. No values from the page JSON go in here.
const WEEK_JS = "(function(){var me=document.currentScript,sec=me&&me.closest('.pdl-sec--week');if(!sec)return;var sc=sec.querySelector('.pdl-week'),box=sec.querySelector('.pdl-week__btns');if(!sc||!box)return;var b=box.querySelectorAll('.pdl-week__btn');box.hidden=false;" +
  "function card(){var it=sc.querySelector('.pdl-week__item');return it?it.getBoundingClientRect().width+28:300}" +
  "function upd(){b[0].disabled=sc.scrollLeft<=4;b[1].disabled=sc.scrollLeft+sc.clientWidth>=sc.scrollWidth-4}" +
  "for(var i=0;i<b.length;i++){b[i].addEventListener('click',function(){var w=card(),n=Math.max(1,Math.floor(sc.clientWidth/w)-1);sc.scrollBy({left:w*n*Number(this.getAttribute('data-dir')),behavior:'smooth'})})}" +
  "sc.addEventListener('scroll',upd,{passive:true});window.addEventListener('resize',upd);upd()})();";
const TICK = '<svg class="pdl-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12l5 5L20 7"/></svg>';

const heading = (key) => [
  { k: `${key}.eyebrow`, label: 'Small label above heading', type: 'text' },
  { k: `${key}.heading`, label: 'Heading', type: 'text' },
  { k: `${key}.headingAccent`, label: 'Heading, highlighted end (italic)', type: 'text', help: 'Shown in italics after the heading. Leave empty for none.' },
];

export const LANDING_SCHEMA = {
  page: {
    label: 'Page settings',
    fields: [
      { k: 'name', label: 'Page name', type: 'text', help: 'Used in the browser tab and the page list.' },
      { k: 'seo.title', label: 'Search result title', type: 'text', help: 'Aim for under 60 characters.' },
      { k: 'seo.description', label: 'Search result description', type: 'multiline', help: 'Aim for 140–160 characters.' },
      { k: 'seo.ogImage', label: 'Social share image', type: 'image' },
      { k: 'settings.quizUrl', label: 'Quiz link', type: 'url' },
      { k: 'settings.bookletUrl', label: 'Request booklet link', type: 'url' },
      { k: 'settings.advisorUrl', label: 'Talk to an advisor link', type: 'url' },
      { k: 'settings.applyUrl', label: 'Apply link', type: 'url' },
    ],
  },
  hero: {
    label: 'Hero',
    fields: [
      { k: 'hero.eyebrow', label: 'Small label above title', type: 'text' },
      { k: 'hero.headline', label: 'Headline', type: 'multiline' },
      { k: 'hero.headlineAccent', label: 'Headline, underlined end (italic)', type: 'text' },
      { k: 'hero.intro', label: 'Intro', type: 'multiline' },
      { k: 'hero.primaryText', label: 'Main button text (goes to the quiz link)', type: 'text' },
      { k: 'hero.secondaryText', label: 'Second button text (goes to the booklet link)', type: 'text' },
      { k: 'hero.image', label: 'Background photo', type: 'image' },
      { k: 'hero.imageAlt', label: 'Background photo description', type: 'text' },
      { k: 'hero.imageFocus', label: 'Photo focus on computers', type: 'focus', image: 'hero.image', help: 'Click the part of the photo that should stay in view.' },
      { k: 'hero.imageFocusMobile', label: 'Photo focus on phones', type: 'focus', image: 'hero.image', mobile: true, help: 'Phones show a narrow slice. Click the part that must stay in view.' },
    ],
  },
  sections: {
    stats:   { fields: [] },
    reasons: { fields: heading('reasons') },
    compare: { fields: [...heading('compare'),
      { k: 'compare.usTag', label: 'Our column: small label', type: 'text' },
      { k: 'compare.usLabel', label: 'Our column: name', type: 'text' },
      { k: 'compare.col1', label: 'Column 2 heading', type: 'text', help: 'Leave a column heading empty to hide that column.' },
      { k: 'compare.col2', label: 'Column 3 heading', type: 'text' },
      { k: 'compare.col3', label: 'Column 4 heading', type: 'text' },
      { k: 'compare.note', label: 'Small print under the table', type: 'text' }] },
    week:    { fields: [...heading('week'), { k: 'week.hint', label: 'Swipe hint', type: 'text' }] },
    voices:  { fields: [...heading('voices'),
      { k: 'voices.rating', label: 'Rating badge: score', type: 'text', help: 'e.g. 4.75. Leave empty to hide the badge.' },
      { k: 'voices.ratingText', label: 'Rating badge: text', type: 'text' },
      { k: 'voices.ratingUrl', label: 'Rating badge: link (optional)', type: 'url' }] },
    ribbon:  { fields: [{ k: 'ribbon.label', label: 'Description of the photo strip (for screen readers)', type: 'text' }] },
    safety:  { fields: [...heading('safety'),
      { k: 'safety.image', label: 'Main photo', type: 'image' },
      { k: 'safety.imageAlt', label: 'Main photo description', type: 'text' },
      { k: 'safety.printImage', label: 'Small print photo', type: 'image' },
      { k: 'safety.printImageAlt', label: 'Small print photo description', type: 'text' },
      { k: 'safety.printCaption', label: 'Small print caption', type: 'text' }] },
    offer:   { fields: [...heading('offer'),
      { k: 'offer.note', label: 'Line under the list', type: 'text' },
      { k: 'offer.tag', label: 'Offer card: tag', type: 'text', help: 'Leave the offer title empty to hide the card.' },
      { k: 'offer.title', label: 'Offer card: title', type: 'multiline' },
      { k: 'offer.body', label: 'Offer card: details', type: 'text' },
      { k: 'offer.buttonText', label: 'Offer card: button text (goes to the apply link)', type: 'text' },
      { k: 'offer.stubLabel', label: 'Ticket stub: first label', type: 'text' },
      { k: 'offer.stubBig', label: 'Ticket stub: big text', type: 'text' },
      { k: 'offer.stubSmall', label: 'Ticket stub: text under it', type: 'text' },
      { k: 'offer.stubLabel2', label: 'Ticket stub: second label', type: 'text' },
      { k: 'offer.stubText', label: 'Ticket stub: second text', type: 'text' }] },
    faq:     { fields: [{ k: 'faq.heading', label: 'Heading', type: 'text' }, { k: 'faq.headingAccent', label: 'Heading, highlighted end (italic)', type: 'text' }] },
    cta:     { fields: [...heading('cta'),
      { k: 'cta.body', label: 'Supporting line', type: 'multiline' },
      { k: 'cta.image', label: 'Background photo', type: 'image' },
      { k: 'cta.imageAlt', label: 'Background photo description', type: 'text' },
      { k: 'cta.primaryText', label: 'Main button (quiz link)', type: 'text' },
      { k: 'cta.secondaryText', label: 'Second button (booklet link)', type: 'text' },
      { k: 'cta.tertiaryText', label: 'Third button (advisor link)', type: 'text' }] },
  },
  lists: {
    'stats.items':     { label: 'Stat', add: 'Add a stat', fields: [{ k: 'value', label: 'Number', type: 'text' }, { k: 'label', label: 'Label', type: 'text' }], blank: { value: '0', label: 'label' } },
    'reasons.items':   { label: 'Reason', add: 'Add a reason', fields: [{ k: 'icon', label: 'Icon', type: 'select', options: LANDING_ICONS }, { k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }], blank: { icon: 'Compass', title: 'New reason', body: 'Describe it in a sentence or two.' } },
    'compare.rows':    { label: 'Comparison row', add: 'Add a row', fields: [{ k: 'label', label: 'What’s compared', type: 'text' }, { k: 'us', label: 'Pacific Discovery', type: 'text' }, { k: 'c1', label: 'Column 2', type: 'text' }, { k: 'c2', label: 'Column 3', type: 'text' }, { k: 'c3', label: 'Column 4', type: 'text' }], blank: { label: 'Topic', us: 'Our answer', c1: '', c2: '', c3: '' } },
    'week.days':       { label: 'Day', add: 'Add a day', fields: [{ k: 'day', label: 'Day', type: 'text' }, { k: 'title', label: 'What happens', type: 'text' }, { k: 'image', label: 'Photo', type: 'image' }, { k: 'imageAlt', label: 'Photo description', type: 'text' }], blank: { day: 'Day', title: 'What happens', image: '', imageAlt: '' } },
    'voices.quotes':   { label: 'Quote', add: 'Add a quote', fields: [{ k: 'quote', label: 'Quote', type: 'multiline', help: 'No need to type quote marks.' }, { k: 'name', label: 'Who said it', type: 'text' }, { k: 'detail', label: 'Program or role', type: 'text' }], blank: { quote: 'Quote', name: 'Name', detail: '' } },
    'ribbon.images':   { label: 'Photo', add: 'Add a photo', fields: [{ k: 'image', label: 'Photo', type: 'image' }, { k: 'imageAlt', label: 'Photo description', type: 'text' }], blank: { image: '', imageAlt: '' } },
    'safety.points':   { label: 'Safety point', add: 'Add a point', fields: [{ k: 'title', label: 'Title', type: 'text' }, { k: 'body', label: 'Text', type: 'multiline' }], blank: { title: 'Title.', body: 'Text.' } },
    'offer.included':  { label: 'Included item', add: 'Add an item', fields: [{ k: 'text', label: 'Text', type: 'text' }], blank: { text: 'Included item' } },
    'faq.items':       { label: 'Question', add: 'Add a question', fields: [{ k: 'q', label: 'Question', type: 'text' }, { k: 'a', label: 'Answer', type: 'multiline' }], blank: { q: 'New question?', a: 'Answer.' } },
  },
};

export function blankLanding(name = 'New landing page') {
  return {
    v: 1,
    template: 'landing',
    name,
    seo: { title: `${name} | Pacific Discovery`, description: '', ogImage: '' },
    settings: {
      quizUrl: 'https://apply.pacificdiscovery.org/quiz',
      bookletUrl: 'https://www.pacificdiscovery.org/admissions/request-program-booklet',
      advisorUrl: 'https://www.pacificdiscovery.org/contact',
      applyUrl: 'https://www.pacificdiscovery.org/apply',
    },
    layout: LANDING_SECTIONS.map((s) => ({ key: s.key, show: true })),
    hero: { eyebrow: '', headline: name, headlineAccent: '', intro: '[One or two sentences]', primaryText: 'Take the 3-minute quiz', secondaryText: 'Request a program booklet', image: '', imageAlt: '', imageFocus: '', imageFocusMobile: '', stampNumber: '', stampLabel: 'YEARS', stampRing: 'SINCE 2001 · 25+ YEARS OF GAP YEARS ·' },
    stats: { items: [] },
    reasons: { eyebrow: '', heading: 'Why families choose us', headingAccent: '', items: [] },
    compare: { eyebrow: '', heading: 'How we compare', headingAccent: '', usTag: 'Our way', usLabel: 'Pacific Discovery', col1: '', col2: '', col3: '', note: '', rows: [] },
    week: { eyebrow: '', heading: 'A week in the life', headingAccent: '', hint: 'Swipe to follow the route', days: [] },
    voices: { eyebrow: '', heading: 'In their words', headingAccent: '', rating: '', ratingText: '', ratingUrl: '', quotes: [] },
    ribbon: { label: 'Photos from our programs', images: [] },
    safety: { eyebrow: '', heading: 'Safety', headingAccent: '', image: '', imageAlt: '', printImage: '', printImageAlt: '', printCaption: '', points: [] },
    offer: { eyebrow: '', heading: 'Pricing', headingAccent: '', included: [], note: '', tag: '', title: '', body: '', buttonText: 'Start your application', stubLabel: '', stubBig: '', stubSmall: '', stubLabel2: '', stubText: '' },
    faq: { heading: 'Questions', headingAccent: '', items: [] },
    cta: { eyebrow: '', heading: 'Ready to go?', headingAccent: '', body: '', image: '', imageAlt: '', primaryText: 'Take the 3-minute quiz', secondaryText: 'Request a booklet', tertiaryText: 'Talk to an advisor' },
  };
}

export function normalizeLanding(p) {
  const base = blankLanding(p?.name || 'Landing page');
  const out = { ...base, ...(p || {}), template: 'landing' };
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = { ...base[k], ...((p && p[k]) || {}) };
  }
  for (const lp of Object.keys(LANDING_SCHEMA.lists)) {
    const [a, b] = lp.split('.');
    if (!Array.isArray(out[a][b])) out[a][b] = [];
  }
  const known = new Set(LANDING_SECTIONS.map((s) => s.key));
  const seen = new Set();
  const layout = [];
  for (const l of Array.isArray(p?.layout) ? p.layout : []) {
    if (l && known.has(l.key) && !seen.has(l.key)) { layout.push({ key: l.key, show: l.show !== false }); seen.add(l.key); }
  }
  for (const s of LANDING_SECTIONS) if (!seen.has(s.key)) layout.push({ key: s.key, show: true });
  out.layout = layout;
  return out;
}

// Section heading: eyebrow, then heading with an italic highlighted end.
function lHead(c, key, o = {}) {
  const eb = c.t(`${key}.eyebrow`, 'span', 'pdl-eyebrow__t');
  return `<div class="pdl-head${o.cls ? ` ${o.cls}` : ''}">` +
    (eb ? `<p class="pdl-eyebrow"><span class="pdl-eyebrow__line" aria-hidden="true"></span>${eb}</p>` : '') +
    `<h2 class="pdl-h2">${c.t(`${key}.heading`, 'span', '')} ${c.t(`${key}.headingAccent`, 'em', 'pdl-accent')}</h2></div>`;
}

const wave = (fill, d = 'M0,0 L1440,0 L1440,20 C1180,60 900,10 720,30 C480,58 240,8 0,36 Z') =>
  `<svg class="pdl-wave" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${d}" fill="${attr(fill)}"/></svg>`;

const L = {
  stats(p, c) {
    return c.list('stats.items', 'div', 'pdl-stats', (it, ip) =>
      `${c.t(`${ip}.value`, 'strong', 'pdl-stat__v')}${c.t(`${ip}.label`, 'span', 'pdl-stat__l')}`, 'div', 'pdl-stat');
  },
  reasons(p, c) {
    return lHead(c, 'reasons') +
      c.list('reasons.items', 'div', 'pdl-reasons', (it, ip, i) =>
        `<div class="pdl-reason__top"><span class="pdl-reason__ico"${c.ed ? ` data-v="${attr(`${ip}.icon`)}"` : ''}>${icon(it.icon)}</span><span class="pdl-reason__n" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span></div>` +
        `${c.t(`${ip}.title`, 'h3', 'pdl-h3')}${c.t(`${ip}.body`, 'p', '', { multiline: true })}`, 'article', 'pdl-reason');
  },
  compare(p, c) {
    const cols = ['col1', 'col2', 'col3'].filter((k) => c.ed || String(p.compare[k] || '').trim());
    const grid = ` style="--pdl-cols:${cols.length}"`;
    const head = `<div class="pdl-cmp__row pdl-cmp__row--head" role="row"><span role="columnheader" class="pdl-cmp__corner"></span>` +
      `<span role="columnheader" class="pdl-cmp__us pdl-cmp__us--head">${c.t('compare.usTag', 'small', 'pdl-cmp__tag')}${c.t('compare.usLabel', 'span', '')}</span>` +
      cols.map((k) => `<span role="columnheader" class="pdl-cmp__th">${c.t(`compare.${k}`, 'span', '', { ph: 'Column heading (empty hides it)' })}</span>`).join('') + `</div>`;
    const rows = c.list('compare.rows', 'div', 'pdl-cmp__body', (it, ip) =>
      `<span role="rowheader" class="pdl-cmp__label">${c.t(`${ip}.label`, 'span', '')}</span>` +
      `<span role="cell" class="pdl-cmp__us">${TICK}${c.t(`${ip}.us`, 'span', '')}</span>` +
      cols.map((k) => `<span role="cell" class="pdl-cmp__td">${c.t(`${ip}.${k.replace('col', 'c')}`, 'span', '', { ph: '—' })}</span>`).join(''),
      'div', 'pdl-cmp__row');
    return lHead(c, 'compare') +
      `<div class="pdl-cmp"><div class="pdl-cmp__scroll" role="table" aria-label="${attr(p.compare.heading || 'Comparison')}"${grid}>${head}${rows}</div></div>` +
      c.t('compare.note', 'p', 'pdl-small');
  },
  week(p, c) {
    const hint = c.t('week.hint', 'span', '');
    return `<div class="pdl-wrap"><div class="pdl-head-row">${lHead(c, 'week')}` +
      `<div class="pdl-week__nav">` +
      (hint ? `<p class="pdl-swipe">${hint}<svg viewBox="0 0 28 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 6h25M21 1l5 5-5 5"/></svg></p>` : '') +
      // Arrow buttons for mouse users. Hidden until the script below wires them up (live page only).
      `<div class="pdl-week__btns"${c.ed ? '' : ' hidden'}>` +
      `<button type="button" class="pdl-week__btn" data-dir="-1" aria-label="Previous days"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg></button>` +
      `<button type="button" class="pdl-week__btn" data-dir="1" aria-label="Next days"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg></button>` +
      `</div></div>` +
      `</div></div>` +
      `<div class="pdl-week" tabindex="0" aria-label="${attr(`${p.week.heading || 'A week in the life'} ${p.week.headingAccent || ''}`.trim())}, scrollable">` +
      c.list('week.days', 'ol', 'pdl-week__track', (it, ip, i) =>
        // Dotted route to the next pin: down from a high pin, up from a low one (hidden on the last day by CSS).
        `<svg class="pdl-week__link" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${i % 2 ? 'M0,36 C50,36 50,0 100,0' : 'M0,0 C50,0 50,36 100,36'}" vector-effect="non-scaling-stroke"/></svg>` +
        `<span class="pdl-week__pin" aria-hidden="true"></span>` +
        `<figure class="pdl-week__fig">${c.img(`${ip}.image`, `${ip}.imageAlt`, 'pdl-week__img', 'Add a photo')}` +
        `<figcaption>${c.t(`${ip}.day`, 'span', 'pdl-week__day')}${c.t(`${ip}.title`, 'span', 'pdl-week__title')}</figcaption></figure>`,
        'li', 'pdl-week__item') +
      `</div>` + (c.ed ? '' : `<script>${WEEK_JS}</script>`);
  },
  voices(p, c) {
    const v = p.voices;
    const rating = v.rating || c.ed
      ? `<div class="pdl-rating"${c.ed ? ' data-v="voices.rating"' : ''}><strong class="pdl-rating__n">${esc(v.rating || 'Score')}</strong><span class="pdl-rating__stars" aria-hidden="true">★★★★★</span>` +
        (v.ratingUrl && !c.ed ? `<a class="pdl-rating__t" href="${attr(safeUrl(v.ratingUrl))}">${esc(v.ratingText)}</a>` : `<span class="pdl-rating__t">${esc(v.ratingText)}</span>`) + `</div>`
      : '';
    return `<div class="pdl-head-row">${lHead(c, 'voices', { cls: 'pdl-head--inv' })}${rating}</div>` +
      c.list('voices.quotes', 'div', 'pdl-quotes', (it, ip) =>
        `<span class="pdl-quote__mark" aria-hidden="true">“</span>${c.t(`${ip}.quote`, 'p', 'pdl-quote__text', { multiline: true })}` +
        `<footer class="pdl-quote__by">${c.t(`${ip}.name`, 'span', '')}${it.detail || c.ed ? ` · ${c.t(`${ip}.detail`, 'span', '', { ph: 'Program or role' })}` : ''}</footer>`,
        'blockquote', 'pdl-quote');
  },
  ribbon(p, c) {
    return c.list('ribbon.images', 'div', 'pdl-ribbon', (it, ip) => c.img(`${ip}.image`, `${ip}.imageAlt`, 'pdl-ribbon__img', 'Add a photo'), 'figure', 'pdl-ribbon__item');
  },
  safety(p, c) {
    const s = p.safety;
    const print = s.printImage || c.ed
      ? `<figure class="pdl-print pdl-print--sm">${c.img('safety.printImage', 'safety.printImageAlt', 'pdl-print__img', 'Add a photo')}${c.t('safety.printCaption', 'figcaption', 'pdl-print__cap')}</figure>` : '';
    return `<div class="pdl-safety"><div class="pdl-safety__media">${s.image || c.ed ? `<span class="pdl-safety__block" aria-hidden="true"></span>${c.img('safety.image', 'safety.imageAlt', 'pdl-safety__img', 'Add a photo')}` : ''}${print}</div>` +
      `<div class="pdl-safety__text">${lHead(c, 'safety')}` +
      c.list('safety.points', 'ol', 'pdl-points', (it, ip, i) =>
        `<span class="pdl-points__n" aria-hidden="true">${i + 1}</span><div>${c.t(`${ip}.title`, 'strong', '')} ${c.t(`${ip}.body`, 'span', '', { multiline: true })}</div>`, 'li', 'pdl-points__item') +
      `</div></div>`;
  },
  offer(p, c) {
    const o = p.offer;
    const card = o.title || c.ed
      ? `<div class="pdl-pass"><div class="pdl-pass__main">${c.t('offer.tag', 'span', 'pdl-pass__tag')}${c.t('offer.title', 'p', 'pdl-pass__title', { multiline: true, ph: 'Offer title (empty hides the card)' })}${c.t('offer.body', 'p', '')}` +
        `${c.link('offer.buttonText', p.settings.applyUrl, 'pdl-btn', 'settings.applyUrl')}</div>` +
        (o.stubBig || o.stubText || c.ed ? `<div class="pdl-pass__stub">${c.t('offer.stubLabel', 'span', 'pdl-pass__lbl')}${c.t('offer.stubBig', 'span', 'pdl-pass__big')}${c.t('offer.stubSmall', 'span', 'pdl-pass__sm')}` +
          `${c.t('offer.stubLabel2', 'span', 'pdl-pass__lbl pdl-pass__lbl--gap')}${c.t('offer.stubText', 'span', 'pdl-pass__sm')}</div>` : '') +
        `</div>` : '';
    return `<div class="pdl-offer"><div class="pdl-offer__text">${lHead(c, 'offer')}` +
      c.list('offer.included', 'ul', 'pdl-incl', (it, ip) => `${TICK}${c.t(`${ip}.text`, 'span', '')}`, 'li', '') +
      c.t('offer.note', 'p', 'pdl-small') + `</div>${card}</div>`;
  },
  faq(p, c) {
    return `<div class="pdl-narrow"><h2 class="pdl-h2">${c.t('faq.heading', 'span', '')} ${c.t('faq.headingAccent', 'em', 'pdl-accent')}</h2>` +
      c.list('faq.items', 'div', 'pdl-faq', (it, ip, i) => c.ed
        ? `<div class="pdl-faq__q">${c.t(`${ip}.q`, 'span', '')}</div>${c.t(`${ip}.a`, 'p', 'pdl-faq__a', { multiline: true })}`
        : `<details${i === 0 ? ' open' : ''}><summary class="pdl-faq__q"><span>${esc(it.q)}</span><span class="pdl-chev" aria-hidden="true"></span></summary><p class="pdl-faq__a pdp-ml">${esc(it.a)}</p></details>`,
      'div', 'pdl-faq__item') + `</div>`;
  },
  cta(p, c) {
    const eb = c.t('cta.eyebrow', 'span', '');
    return `${p.cta.image || c.ed ? `<div class="pdl-bg">${c.img('cta.image', 'cta.imageAlt', 'pdl-bg__img', 'Add a background photo')}</div>` : ''}` +
      `<div class="pdl-cta">` +
      (eb ? `<p class="pdl-eyebrow pdl-eyebrow--center"><span class="pdl-eyebrow__line" aria-hidden="true"></span>${eb}<span class="pdl-eyebrow__line" aria-hidden="true"></span></p>` : '') +
      `<h2 class="pdl-h2 pdl-h2--xl">${c.t('cta.heading', 'span', '')} ${c.t('cta.headingAccent', 'em', '')}</h2>${c.t('cta.body', 'p', 'pdl-cta__body', { multiline: true })}` +
      `<div class="pdl-btns pdl-btns--center">${c.link('cta.primaryText', p.settings.quizUrl, 'pdl-btn pdl-btn--shadow', 'settings.quizUrl')}` +
      `${c.link('cta.secondaryText', p.settings.bookletUrl, 'pdl-btn pdl-btn--light', 'settings.bookletUrl')}` +
      `${c.link('cta.tertiaryText', p.settings.advisorUrl, 'pdl-btn pdl-btn--ghost', 'settings.advisorUrl')}</div></div>`;
  },
};

function renderLandingHero(p, c, nextBg) {
  const h = p.hero;
  const fd = parseFocus(h.imageFocus), fm = parseFocus(h.imageFocusMobile);
  const focus = fd || fm ? ` style="${fd ? `--pdl-pos:${fd};` : ''}${fm ? `--pdl-pos-m:${fm};` : ''}"` : '';
  // The green stamp was removed from the design; old stamp fields in stored pages are ignored.
  const eb = c.t('hero.eyebrow', 'span', '');
  return `<header class="pdl-hero pdl-dark" data-group="hero">` +
    (h.image || c.ed ? `<div class="pdl-bg pdl-bg--hero"${focus}>${c.img('hero.image', 'hero.imageAlt', 'pdl-bg__img', 'Add a background photo')}</div>` : '') +
    `<div class="pdl-wrap pdl-hero__inner"><div class="pdl-hero__text">` +
    (eb ? `<p class="pdl-eyebrow pdl-eyebrow--topaz"><span class="pdl-eyebrow__line" aria-hidden="true"></span>${eb}</p>` : '') +
    `<h1 class="pdl-h1">${c.t('hero.headline', 'span', '', { multiline: true, keep: true })} ${h.headlineAccent || c.ed ? `<span class="pdl-under">${c.t('hero.headlineAccent', 'em', '')}<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M4 14 C 60 4, 120 4, 170 10 S 260 16, 296 6" fill="none" stroke="#81c243" stroke-width="5" stroke-linecap="round"/></svg></span>` : ''}</h1>` +
    `${c.t('hero.intro', 'p', 'pdl-hero__intro', { multiline: true })}` +
    `<div class="pdl-btns">${c.link('hero.primaryText', p.settings.quizUrl, 'pdl-btn pdl-btn--shadow', 'settings.quizUrl')}${c.link('hero.secondaryText', p.settings.bookletUrl, 'pdl-btn pdl-btn--light', 'settings.bookletUrl')}</div>` +
    `</div></div>` +
    wave(nextBg, 'M0,60 C220,10 420,90 720,50 C1000,12 1220,80 1440,40 L1440,90 L0,90 Z').replace('viewBox="0 0 1440 60"', 'viewBox="0 0 1440 90"').replace('class="pdl-wave"', 'class="pdl-wave pdl-wave--bottom"') +
    `</header>`;
}

/** The landing page body: what replaces <main> on pacificdiscovery.org. */
export function renderLanding(page, opts = {}) {
  const p = normalizeLanding(page);
  const c = ctx(p, opts, LANDING_SCHEMA);
  const shownKeys = p.layout.filter((l) => l.show).map((l) => l.key);
  const order = c.ed ? p.layout.map((l) => l.key) : shownKeys;
  const bgBefore = (key) => {
    const i = shownKeys.indexOf(key);
    return i > 0 ? LSEC[shownKeys[i - 1]].bg : '#212121';
  };
  const secs = order.map((key) => {
    const meta = LSEC[key];
    const hidden = !p.layout.find((l) => l.key === key)?.show;
    const inner = L[key](p, c);
    const full = key === 'week' || key === 'ribbon' || key === 'cta';
    const prev = bgBefore(key);
    const waveTop = meta.wave && prev !== meta.bg ? wave(prev) : '';
    const attrs = key === 'ribbon' && p.ribbon.label ? ` aria-label="${attr(p.ribbon.label)}"` : '';
    return `<section id="${meta.anchor}" class="pdl-sec pdl-sec--${key}${hidden ? ' pde-hidden' : ''}${waveTop ? ' pdl-sec--wave' : ''}"${attrs}${c.ed ? ` data-sec="${key}" data-label="${attr(meta.label)}"` : ''}>` +
      waveTop + (full ? inner : `<div class="pdl-wrap">${inner}</div>`) + `</section>`;
  }).join('');
  const first = shownKeys[0];
  return `<div class="pdl${c.ed ? ' pdp--edit' : ''}">${renderLandingHero(p, c, first ? LSEC[first].bg : '#ffffff')}${secs}</div>`;
}

export function landingSeo(page, { canonicalBase = `https://www.pacificdiscovery.org${LANDING_BASE}`, slug = '' } = {}) {
  const p = normalizeLanding(page);
  return {
    title: p.seo.title || `${p.name} | Pacific Discovery`,
    description: p.seo.description || String(p.hero.intro || '').slice(0, 160),
    canonical: slug ? `${canonicalBase}${slug}` : '',
    ogImage: p.seo.ogImage || p.hero.image || '',
  };
}

/** FAQPage structured data from the FAQ section (only when it's shown). */
export function landingJsonLd(page) {
  const p = normalizeLanding(page);
  const faqOn = p.layout.find((l) => l.key === 'faq')?.show;
  const items = faqOn ? p.faq.items.filter((x) => x.q && x.a) : [];
  if (!items.length) return '';
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
  }).replace(/</g, '\\u003c');
}

const GRAIN_DARK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.13 0 0 0 0 0.13 0 0 0 0 0.13 0 0 0 1.6 -0.55'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.09'/%3E%3C/svg%3E\")";
const GRAIN_LIGHT = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1.6 -0.55'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.09'/%3E%3C/svg%3E\")";

export const LANDING_CSS = `
.pdl{--pdl-topaz:#55bbd2;--pdl-topaz-dk:#1f7f95;--pdl-green:#81c243;--pdl-navy:#344f8d;--pdl-ink:#212121;--pdl-body:#4a4a4a;--pdl-muted:#5f666b;--pdl-grey:#f1f1f1;
  font-family:Poppins,system-ui,sans-serif;color:var(--pdl-body);font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased;text-align:left;overflow-x:hidden}
.pdl *,.pdl *::before,.pdl *::after{box-sizing:border-box}
.pdl :where(h1,h2,h3,p,ul,ol,li,figure,blockquote,figcaption){margin:0;padding:0}
.pdl :where(ul,ol){list-style:none}
.pdl :where(h1,h2,h3,h4,p,li,a,span,strong,em,small,blockquote,summary,footer,figcaption){font-family:inherit;font-size:inherit;line-height:inherit;letter-spacing:normal;text-transform:none}
.pdl img{max-width:100%}
.pdl .pdp-ml{white-space:pre-line}
.pdl-wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.pdl-narrow{max-width:852px;margin:0 auto}
.pdl-sec{position:relative;padding:112px 0 104px}
.pdl-sec--wave{padding-top:128px}
.pdl-wave{position:absolute;left:0;top:-1px;width:100%;height:60px;display:block}
.pdl-wave--bottom{top:auto;bottom:-1px;height:90px}
.pdl-small{font-size:14px;color:var(--pdl-muted);margin-top:16px}
/* headings */
.pdl .pdl-h1{text-transform:none;font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#fff;font-size:clamp(44px,6vw,82px);line-height:1.02}
.pdl .pdl-h2{text-transform:none;font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:var(--pdl-body);font-size:clamp(34px,4.4vw,54px);line-height:1.08}
.pdl .pdl-h2--xl{font-size:clamp(40px,5.4vw,68px);line-height:1.04;color:#fff}
.pdl .pdl-h3{text-transform:none;color:var(--pdl-body);font-size:21px;font-weight:600;line-height:1.3}
.pdl em{font-style:italic}
.pdl .pdl-accent{color:var(--pdl-topaz-dk)}
.pdl-head{max-width:700px;display:flex;flex-direction:column;gap:14px;margin-bottom:48px}
.pdl-head-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:20px 24px;margin-bottom:40px}
.pdl-head-row .pdl-head{margin-bottom:0}
.pdl .pdl-eyebrow{display:inline-flex;align-items:center;gap:14px;color:var(--pdl-topaz-dk);font-weight:600;letter-spacing:.14em;font-size:clamp(17px,1.6vw,22px);text-transform:uppercase}
.pdl .pdl-eyebrow span{letter-spacing:.14em;text-transform:uppercase}
.pdl-eyebrow__line{width:52px;height:3px;background:var(--pdl-topaz);flex:none}
.pdl .pdl-eyebrow--topaz{color:var(--pdl-topaz)}
.pdl .pdl-eyebrow--center{justify-content:center;color:var(--pdl-topaz)}
.pdl .pdl-head--inv .pdl-h2{color:#fff}
.pdl .pdl-head--inv .pdl-eyebrow{color:#9fdcec}
.pdl-head--inv .pdl-eyebrow__line{background:#9fdcec}
.pdl .pdl-head--inv .pdl-accent{color:#fff}
/* buttons */
.pdl-btns{display:flex;gap:14px;flex-wrap:wrap;padding-top:8px}
.pdl-btns--center{justify-content:center}
.pdl .pdl-btn{display:inline-flex;align-items:center;min-height:52px;padding:14px 30px;border-radius:999px;background:var(--pdl-topaz);color:#fff;text-decoration:none;font-weight:600;font-size:16px;line-height:1.2;transition:background .15s}
.pdl .pdl-btn:hover{background:#23a3c0;color:#fff}
.pdl .pdl-btn--shadow{box-shadow:0 10px 24px rgba(0,0,0,.25)}
.pdl .pdl-btn--light{background:#fff;color:var(--pdl-body)}
.pdl .pdl-btn--light:hover{background:var(--pdl-grey);color:var(--pdl-ink)}
.pdl .pdl-btn--ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.75)}
.pdl .pdl-btn--ghost:hover{background:rgba(255,255,255,.12);color:#fff}
.pdl .pdl-btn:focus-visible{outline:3px solid #fff;outline-offset:3px}
/* photo backgrounds */
.pdl-dark{background:var(--pdl-ink);color:#fff}
.pdl-bg{position:absolute;inset:0}
.pdl .pdl-bg__img{width:100%;height:100%;object-fit:cover;object-position:var(--pdl-pos,center 45%);display:block;opacity:.45}
.pdl-sec--cta .pdl-bg__img{opacity:.38}
@media (max-width:700px){.pdl .pdl-bg--hero .pdl-bg__img{object-position:var(--pdl-pos-m,var(--pdl-pos,center 45%))}}
/* hero */
.pdl-hero{position:relative;overflow:hidden}
.pdl-hero__inner{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:56px;padding-top:88px;padding-bottom:140px}
.pdl-hero__text{flex:1 1 520px;min-width:0;display:flex;flex-direction:column;gap:24px}
.pdl .pdl-hero__intro{color:#f1f1f1;font-size:20px;max-width:560px}
.pdl-under{position:relative;display:inline-block}
.pdl-under svg{position:absolute;left:0;bottom:-10px;width:100%;height:18px}
.pdl-hero__art{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.pdl .pdl-print{position:absolute;background:#fff;display:flex;flex-direction:column;box-shadow:0 24px 48px rgba(0,0,0,.35)}
.pdl .pdl-print__img{width:100%;object-fit:cover;display:block}
.pdl .pdl-print__cap{text-align:center;font-family:'DM Serif Display',Georgia,serif;font-style:italic;color:var(--pdl-body);line-height:1.25}
.pdl-stamp{width:clamp(130px,16vw,210px);transform:rotate(-12deg);filter:drop-shadow(0 16px 28px rgba(0,0,0,.35))}
.pdl-stamp svg{display:block;width:100%;height:auto}
@media (max-width:900px){.pdl-hero__inner{padding-top:56px;gap:32px}.pdl-hero__art{justify-content:flex-start}}
/* stats */
.pdl-sec--stats{background-color:var(--pdl-topaz);color:#fff;padding:28px 0 44px}
.pdl-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;text-align:center}
@media (max-width:860px){.pdl-stats{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:28px}}
.pdl-stat{display:flex;flex-direction:column;gap:2px}
.pdl .pdl-stat__v{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:clamp(32px,7vw,44px);line-height:1.1;color:#fff}
.pdl .pdl-stat__l{font-size:14px;font-weight:500;color:#fff}
/* reasons */
.pdl-sec--reasons{background-color:#fff;background-image:radial-gradient(rgba(74,74,74,.10) 1px,transparent 1.6px);background-size:22px 22px}
.pdl-reasons{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
.pdl-reason{background:#fff;border-radius:20px;padding:32px 28px;box-shadow:0 18px 40px rgba(33,33,33,.08);display:flex;flex-direction:column;gap:14px}
.pdl-reason__top{display:flex;justify-content:space-between;align-items:flex-start}
.pdl-reason__ico{color:var(--pdl-topaz);display:inline-flex}
.pdl-ico{width:44px;height:44px}
.pdl-reason__n{font-family:'DM Serif Display',Georgia,serif;font-size:52px;line-height:1;color:#e3f3f8}
@media (max-width:420px){.pdl-reasons{grid-template-columns:1fr}}
/* comparison */
.pdl-sec--compare{background-color:var(--pdl-grey);background-image:${GRAIN_DARK}}
.pdl-cmp{overflow-x:auto;background:#fff;border-radius:22px;box-shadow:0 24px 60px rgba(33,33,33,.10);padding:8px;-webkit-overflow-scrolling:touch}
.pdl-cmp__scroll{min-width:calc(380px + var(--pdl-cols,3) * 170px);font-size:16px}
.pdl-cmp__row{display:grid;grid-template-columns:minmax(180px,1.3fr) minmax(200px,1.1fr) repeat(var(--pdl-cols,3),minmax(150px,1fr))}
.pdl-cmp__row>span{padding:20px 24px;border-top:1px solid #e1e6e8}
.pdl-cmp__row--head>span{border-top:0;padding:24px;font-weight:600;color:var(--pdl-body)}
.pdl .pdl-cmp__us{background:#eef8fb;color:var(--pdl-ink);font-weight:500;border-top-color:#d6eef5;display:flex;gap:10px;align-items:flex-start}
.pdl .pdl-cmp__us--head{background:var(--pdl-topaz);color:#fff;border-radius:16px 16px 0 0;flex-direction:column;gap:0}
.pdl .pdl-cmp__tag{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.9}
.pdl-cmp__body>.pdl-cmp__row:last-child .pdl-cmp__us{border-radius:0 0 16px 16px}
.pdl .pdl-cmp__label{font-weight:600;color:var(--pdl-body)}
.pdl-tick{width:20px;height:20px;flex:none;margin-top:3px;color:var(--pdl-green)}
/* week */
.pdl-sec--week{background-color:#fbfaf7;background-image:${GRAIN_DARK};padding-bottom:0}
.pdl-week__nav{display:flex;align-items:center;gap:20px}
.pdl-week__btns{display:flex;gap:10px}
.pdl-week__btns[hidden]{display:none}
.pdl .pdl-week__btn{width:52px;height:52px;border-radius:50%;border:2px solid var(--pdl-topaz);background:#fff;color:var(--pdl-topaz-dk);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .15s,color .15s,opacity .15s;box-shadow:0 6px 16px rgba(33,33,33,.08)}
.pdl .pdl-week__btn svg{width:22px;height:22px}
.pdl .pdl-week__btn:hover:not(:disabled){background:var(--pdl-topaz);color:#fff}
.pdl .pdl-week__btn:focus-visible{outline:3px solid var(--pdl-topaz-dk);outline-offset:3px}
.pdl .pdl-week__btn:disabled{opacity:.35;cursor:default;box-shadow:none}
@media (hover:hover) and (min-width:701px){.pdl-week__btns:not([hidden])~.pdl-swipe,.pdl-week__nav:has(.pdl-week__btns:not([hidden])) .pdl-swipe{display:none}}
@media (hover:none),(max-width:700px){.pdl-week__btns{display:none!important}}
.pdl .pdl-swipe{display:inline-flex;align-items:center;gap:10px;color:var(--pdl-muted);font-size:14px;font-weight:500}
.pdl-swipe svg{width:28px;height:12px;color:var(--pdl-topaz)}
.pdl-week{overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-left:max(24px,calc((100% - 1192px) / 2));padding-bottom:112px;-webkit-overflow-scrolling:touch}
.pdl-week:focus-visible{outline:3px solid var(--pdl-topaz);outline-offset:-3px}
.pdl-week__track{position:relative;display:flex;gap:28px;width:max-content;min-width:100%;padding:0 max(24px,calc((100% - 1192px) / 2))}
.pdl-week__item{position:relative;flex:none;width:clamp(230px,24vw,270px);scroll-snap-align:start;display:flex;flex-direction:column;align-items:center;gap:16px}
.pdl-week__pin{position:relative;z-index:1;width:22px;height:22px;border-radius:50%;background:#fff;border:5px solid var(--pdl-topaz)}
.pdl-week__item:last-child .pdl-week__pin{background:var(--pdl-green);border-color:var(--pdl-green)}
.pdl-week__fig{width:100%;display:flex;flex-direction:column;gap:14px}
.pdl-week__item:nth-child(even){padding-top:36px}
.pdl-week__link{position:absolute;left:50%;top:11px;width:calc(100% + 28px);height:36px;overflow:visible}
.pdl-week__link path{fill:none;stroke:var(--pdl-topaz);stroke-width:3;stroke-linecap:round;stroke-dasharray:0 9}
.pdl-week__item:last-child .pdl-week__link{display:none}
.pdl .pdl-week__img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:16px;box-shadow:0 16px 34px rgba(33,33,33,.14);display:block}
.pdl-week__fig figcaption{display:flex;flex-direction:column;gap:2px}
.pdl .pdl-week__day{color:var(--pdl-topaz-dk);font-weight:600;font-size:13px;letter-spacing:.1em;text-transform:uppercase}
.pdl .pdl-week__title{color:var(--pdl-body);font-weight:600}
.pdl-week + .pde-add{margin:-80px auto 40px;max-width:1192px}
/* quotes */
.pdl-sec--voices{background-color:var(--pdl-navy);background-image:radial-gradient(ellipse at 10% 0%,rgba(85,187,210,.28),transparent 55%),radial-gradient(ellipse at 95% 100%,rgba(129,194,67,.14),transparent 50%),${GRAIN_LIGHT};color:#fff}
.pdl-rating{display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.10);border-radius:999px;padding:12px 22px;flex-wrap:wrap}
.pdl .pdl-rating__n{font-family:'DM Serif Display',Georgia,serif;font-weight:400;font-size:34px;line-height:1;color:#fff}
.pdl-rating__stars{color:#ffd166;letter-spacing:2px;font-size:18px}
.pdl .pdl-rating__t{font-size:14px;color:#e3e9f6}
.pdl a.pdl-rating__t{color:#fff}
.pdl-quotes{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;align-items:start}
.pdl .pdl-quote{margin:0;padding:36px 32px 32px;border:0;border-radius:20px;background:#415d9e;display:flex;flex-direction:column;gap:18px;position:relative;quotes:none;font-style:normal;max-width:none}
.pdl .pdl-quote::before,.pdl .pdl-quote::after{content:none;display:none}
.pdl .pdl-quote:nth-child(3n+2){background:#fff;margin-top:32px}
.pdl-quote__mark{font-family:'DM Serif Display',Georgia,serif;font-size:96px;line-height:.6;color:var(--pdl-topaz);height:40px}
.pdl-quote:nth-child(3n+2) .pdl-quote__mark{color:var(--pdl-green)}
.pdl .pdl-quote__text{font-family:'DM Serif Display',Georgia,serif;font-size:24px;line-height:1.35;color:#fff}
.pdl .pdl-quote:nth-child(3n+2) .pdl-quote__text{color:var(--pdl-ink)}
.pdl .pdl-quote__by{font-size:15px;color:#e3e9f6}
.pdl .pdl-quote:nth-child(3n+2) .pdl-quote__by{color:var(--pdl-body)}
@media (max-width:620px){.pdl .pdl-quote:nth-child(3n+2){margin-top:0}}
/* ribbon */
.pdl-sec--ribbon{background:var(--pdl-ink);padding:12px 0}
.pdl-ribbon{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:0 12px}
.pdl .pdl-ribbon__img{width:100%;height:280px;object-fit:cover;display:block}
.pdl-sec--ribbon .pde-add{max-width:600px;margin:12px auto 0}
/* safety */
.pdl-sec--safety{background:#fff;padding:120px 0 112px}
.pdl-safety{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:72px;align-items:center}
.pdl-safety__media{position:relative;padding:0 28px 28px 0}
.pdl-safety__block{position:absolute;right:0;bottom:0;width:82%;height:82%;background:var(--pdl-topaz);border-radius:22px}
.pdl .pdl-safety__img{position:relative;width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:22px;display:block}
.pdl .pdl-print--sm{left:-18px;bottom:-10px;width:42%;padding:8px 8px 0;transform:rotate(-5deg);z-index:2}
.pdl .pdl-print--sm .pdl-print__img{aspect-ratio:1/1}
.pdl .pdl-print--sm .pdl-print__cap{font-size:15px;padding:8px 4px 10px}
.pdl-safety__text{display:flex;flex-direction:column;gap:10px}
.pdl-points{display:flex;flex-direction:column;gap:22px}
.pdl-points__item{display:flex;gap:18px;align-items:flex-start}
.pdl-points__n{flex:none;width:44px;height:44px;border-radius:50%;background:#eef8fb;color:var(--pdl-topaz-dk);display:inline-flex;align-items:center;justify-content:center;font-weight:700}
.pdl .pdl-points strong{color:var(--pdl-ink)}
@media (max-width:620px){.pdl .pdl-print--sm{left:-6px}.pdl-safety{gap:48px}}
/* offer */
.pdl-sec--offer{background-color:var(--pdl-grey);background-image:${GRAIN_DARK}}
.pdl-offer{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:48px;align-items:center}
.pdl-offer__text{display:flex;flex-direction:column;gap:6px}
.pdl-offer__text .pdl-head{margin-bottom:16px}
.pdl-incl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 24px}
.pdl-incl li{display:flex;gap:10px;align-items:flex-start}
.pdl-incl .pdl-tick{margin-top:4px}
@media (max-width:480px){.pdl-incl{grid-template-columns:1fr}}
.pdl-pass{position:relative;background:#fff;border-radius:22px;box-shadow:0 24px 60px rgba(33,33,33,.12);display:flex;flex-wrap:wrap;overflow:hidden}
.pdl-pass__main{flex:1 1 300px;padding:36px;display:flex;flex-direction:column;gap:14px;align-items:flex-start}
.pdl .pdl-pass__tag{background:var(--pdl-green);color:#fff;font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase;border-radius:999px;padding:6px 14px}
.pdl .pdl-pass__title{font-family:'DM Serif Display',Georgia,serif;color:var(--pdl-body);font-size:clamp(38px,4vw,50px);line-height:1.02}
.pdl-pass__stub{flex:0 1 170px;min-width:150px;background:var(--pdl-topaz);color:#fff;padding:36px 24px;display:flex;flex-direction:column;justify-content:center;gap:4px;border-left:3px dashed #fff}
.pdl .pdl-pass__lbl{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.pdl .pdl-pass__lbl--gap{margin-top:16px}
.pdl .pdl-pass__big{font-family:'DM Serif Display',Georgia,serif;font-size:40px;line-height:1}
.pdl .pdl-pass__sm{font-size:16px;font-weight:600}
@media (max-width:520px){.pdl-pass__stub{flex-basis:100%;border-left:0;border-top:3px dashed #fff}}
/* faq */
.pdl-sec--faq{background:#fff}
.pdl-faq{display:flex;flex-direction:column;gap:12px;margin-top:36px}
.pdl-faq__item{background:var(--pdl-grey);border-radius:16px;padding:22px 26px}
.pdl .pdl-faq__q{color:var(--pdl-ink);font-weight:600;font-size:19px;display:flex;justify-content:space-between;gap:16px;align-items:center;cursor:pointer;list-style:none}
.pdl .pdl-faq__q::-webkit-details-marker{display:none}
.pdl .pdl-faq__a{margin-top:12px}
.pdl-chev{flex:none;width:12px;height:12px;border-right:2px solid var(--pdl-topaz-dk);border-bottom:2px solid var(--pdl-topaz-dk);transform:rotate(45deg) translateY(-3px);transition:transform .2s}
.pdl details[open] .pdl-chev{transform:rotate(-135deg)}
/* closing cta */
.pdl-sec--cta{background:var(--pdl-ink);overflow:hidden;padding:128px 24px}
.pdl-cta{position:relative;max-width:900px;margin:0 auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:22px}
.pdl .pdl-cta__body{color:#f1f1f1;font-size:19px;max-width:620px}
@media (max-width:620px){.pdl-sec{padding:80px 0 72px}.pdl-sec--wave{padding-top:96px}.pdl-sec--stats{padding:24px 0 36px}.pdl-sec--week{padding-bottom:0}.pdl-week{padding-bottom:80px}.pdl-sec--cta{padding:96px 20px}.pdl-sec--ribbon{padding:12px 0}.pdl .pdl-ribbon__img{height:200px}}
@media (prefers-reduced-motion:reduce){.pdl *{transition:none!important;scroll-behavior:auto!important}}
`;

// ─── template registry ──────────────────────────────────────────────────────
// Which template a stored page uses, and everything the editor and the build
// need for it. Pages without a `template` field are program pages.

export function templateOf(doc) {
  return doc && doc.template === 'landing' ? 'landing' : 'program';
}

export const TEMPLATES = {
  program: {
    key: 'program', label: 'Program page', base: '/programs/',
    SCHEMA, SECTIONS, blank: blankProgram, normalize: normalizeProgram, render: renderProgram, css: PROGRAM_CSS,
  },
  landing: {
    key: 'landing', label: 'Landing page', base: LANDING_BASE,
    SCHEMA: LANDING_SCHEMA, SECTIONS: LANDING_SECTIONS, blank: blankLanding, normalize: normalizeLanding, render: renderLanding, css: LANDING_CSS,
  },
};

/** Render any stored page with its own template. */
export function renderPage(doc, opts = {}) {
  return TEMPLATES[templateOf(doc)].render(doc, opts);
}

function renderLandingStandalone(page, { slug = '', editable = false, extraHead = '', noindex = true, canonicalBase } = {}) {
  const s = landingSeo(page, canonicalBase ? { slug, canonicalBase } : { slug });
  const ld = editable ? '' : landingJsonLd(page);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(s.title)}</title><meta name="description" content="${attr(s.description)}">` +
    (s.canonical ? `<link rel="canonical" href="${attr(s.canonical)}">` : '') +
    (noindex ? `<meta name="robots" content="noindex">` : '') +
    (s.ogImage ? `<meta property="og:image" content="${attr(safeUrl(s.ogImage))}">` : '') +
    `<meta property="og:title" content="${attr(s.title)}">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">` +
    `<style>body{margin:0;background:#fff}${LANDING_CSS}</style>${extraHead}</head><body>` +
    `<div id="pdp-root">${renderLanding(page, { editable })}</div>` +
    (ld ? `<script type="application/ld+json">${ld}</script>` : '') +
    `</body></html>`;
}
