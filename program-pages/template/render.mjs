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
      { k: 'hero.reviewText', label: 'Review line', type: 'text' },
      { k: 'hero.reviewUrl', label: 'Review link', type: 'url' },
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
    reviews:     { fields: [{ k: 'reviews.heading', label: 'Heading', type: 'text' }, { k: 'reviews.videoUrl', label: 'YouTube or Vimeo link (optional)', type: 'url' }] },
    dates:       { fields: [{ k: 'dates.heading', label: 'Heading', type: 'text' }, { k: 'dates.help', label: 'Help line', type: 'text' }] },
    faq:         { fields: [{ k: 'faq.heading', label: 'Heading', type: 'text' }] },
    cta:         { fields: [{ k: 'cta.heading', label: 'Heading', type: 'text' }, { k: 'cta.body', label: 'Supporting line', type: 'text' }, { k: 'cta.primaryText', label: 'Main button text', type: 'text' }, { k: 'cta.secondaryText', label: 'Second button text', type: 'text' }] },
    related:     { fields: [{ k: 'related.heading', label: 'Heading', type: 'text' }] },
  },
  // Repeatable items. `blank` is what "+ Add" inserts.
  lists: {
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
    'reviews.quotes':    { label: 'Quote', add: 'Add a quote', fields: [{ k: 'quote', label: 'Quote', type: 'multiline' }, { k: 'name', label: 'Who said it', type: 'text' }], blank: { quote: 'Quote', name: 'Name, semester' } },
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
    hero: { eyebrow: 'Gap semester', headline: name, intro: '[One or two sentences on what makes this program special]', image: '', imageAlt: '', reviewText: '', reviewUrl: '' },
    facts: { countries: '[Countries]', start: '', finish: '', weeks: 10, groupMax: 14, ages: '17–22', tuition: 0, flightsEstimate: 0, activityLevel: 'Medium', credit: 'Optional · University of Montana' },
    why: { heading: 'What makes this program different', items: [] },
    route: { heading: 'Your journey at a glance', mapImage: '', mapAlt: '', phases: [] },
    itinerary: { heading: 'Week by week', intro: '', note: 'This is a guide to what you can expect. The order of activities may change.', weeks: [] },
    day: { heading: 'What a typical day looks like', slots: [], notes: [] },
    stay: { heading: 'Where you’ll stay', intro: '', items: [] },
    learning: { heading: 'Learn while you travel', items: [] },
    instructors: { heading: 'Who you’ll travel with', intro: '', people: [] },
    safety: { heading: 'How we keep students safe', items: [], linkText: 'Read our full safety approach', linkUrl: 'https://www.pacificdiscovery.org/safety' },
    cost: { heading: 'What it costs, all in', lines: [], note: '', included: [], excluded: [] },
    reviews: { heading: 'From past students and parents', videoUrl: '', quotes: [] },
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
      return `<${itemTag} class="${itemCls}"${ed ? ` data-item="${attr(ip)}"` : ''}>${each(it, ip, i)}</${itemTag}>`;
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
    const weekly = Number(f.tuition) > 0 && Number(f.weeks) > 0 ? Math.round(Number(f.tuition) / Number(f.weeks) / 10) * 10 : 0;
    return `<h2 class="pdp-h2">${c.t('cost.heading', 'span')}</h2>` +
      `<div class="pdp-split">` +
      `<div class="pdp-card pdp-card--pad pdp-cost">` +
      `<div class="pdp-cost__row pdp-cost__row--lead"><span>Program tuition</span>${c.v('facts.tuition', money(f.tuition, c.cur) || 'Set tuition', 'strong')}</div>` +
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
      (vid ? `<div class="pdp-video"${c.ed ? ' data-v="reviews.videoUrl"' : ''}><iframe src="${attr(vid)}" title="Student video" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : '') +
      c.list('reviews.quotes', 'div', 'pdp-grid pdp-grid--3', (it, ip) =>
        `<blockquote class="pdp-quote">${c.t(`${ip}.quote`, 'p', '', { multiline: true })}<footer>${c.t(`${ip}.name`, 'span', '')}</footer></blockquote>`, 'figure', 'pdp-card pdp-card--pad');
  },
  dates(p, c) {
    return `<h2 class="pdp-h2">${c.t('dates.heading', 'span')}</h2>` +
      c.list('dates.sessions', 'div', 'pdp-dates', (s, ip) => {
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

function renderHero(p, c) {
  const f = p.facts;
  const fact = (label, html) => `<div class="pdp-fact"><span class="pdp-fact__label">${label}</span>${html}</div>`;
  const bg = p.hero.image
    ? `<div class="pdp-hero__media">${c.img('hero.image', 'hero.imageAlt', 'pdp-hero__img')}</div>`
    : (c.ed ? `<div class="pdp-hero__media">${c.img('hero.image', 'hero.imageAlt', 'pdp-hero__img', 'Add a hero photo')}</div>` : '');
  return `<header class="pdp-hero${p.hero.image ? ' pdp-hero--img' : ''}">${bg}` +
    `<div class="pdp-wrap pdp-hero__inner">` +
    `${c.t('hero.eyebrow', 'p', 'pdp-eyebrow')}` +
    `${c.t('hero.headline', 'h1', 'pdp-h1', { multiline: true, keep: true })}` +
    `${c.t('hero.intro', 'p', 'pdp-hero__intro', { multiline: true })}` +
    `<div class="pdp-hero__ctas"><a class="pdp-btn pdp-btn--lg" href="#dates">Check dates &amp; apply</a>` +
    (p.settings.bookletUrl ? `<a class="pdp-btn pdp-btn--lg pdp-btn--inv-ghost" href="${attr(safeUrl(p.settings.bookletUrl))}">Get the itinerary</a>` : '') + `</div>` +
    (p.hero.reviewText || c.ed ? `<p class="pdp-hero__review">${c.link('hero.reviewText', p.hero.reviewUrl, 'pdp-hero__reviewlink', 'hero.reviewUrl')}</p>` : '') +
    `</div></header>` +
    `<div class="pdp-wrap"><div class="pdp-facts"${c.ed ? ' data-group="facts"' : ''}>` +
    fact('Where', c.t('facts.countries', 'strong', '')) +
    fact('Length', c.v('facts.weeks', f.weeks ? `${f.weeks} weeks` : '—', 'strong')) +
    fact('Group', c.v('facts.groupMax', `${f.groupMax ? `Max ${f.groupMax}` : ''}${f.groupMax && f.ages ? ' · ' : ''}${f.ages ? `ages ${String(f.ages).replace(/[-–]/g, '\u2011')}` : ''}` || '—', 'strong')) +
    fact('Tuition', `${c.v('facts.tuition', money(f.tuition, c.cur) || 'Set tuition', 'strong')}${Number(f.flightsEstimate) > 0 ? `<span class="pdp-fact__sub">+ flights est. ${esc(money(f.flightsEstimate, c.cur))}</span>` : ''}`) +
    fact('Activity', c.v('facts.activityLevel', f.activityLevel || '—', 'strong')) +
    fact('College credit', c.t('facts.credit', 'strong', '')) +
    `</div></div>`;
}

function renderBar(p, c, shown) {
  const next = (p.dates.sessions || []).filter((s) => s.start && !/^(full|closed)$/i.test(s.status || '')).sort((a, b) => a.start.localeCompare(b.start))[0];
  const navs = shown.filter((k) => SECTION_BY_KEY[k].nav)
    .map((k) => `<a href="#${SECTION_BY_KEY[k].anchor}">${esc(SECTION_BY_KEY[k].nav)}</a>`).join('');
  return `<nav class="pdp-bar" aria-label="Program sections"><div class="pdp-wrap pdp-bar__inner">` +
    `<div class="pdp-bar__nav"><strong>${esc(p.name)}</strong>${navs}</div>` +
    `<div class="pdp-bar__cta"><span class="pdp-bar__meta">${money(p.facts.tuition, c.cur) ? `From ${esc(money(p.facts.tuition, c.cur))}` : ''}${next ? ` · Next start ${esc(shortDate(next.start))}` : ''}</span>` +
    `<a class="pdp-btn" href="${attr(safeUrl(p.settings.applyUrl))}">Apply now</a></div>` +
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
  return `<div class="pdp${c.ed ? ' pdp--edit' : ''}">${renderHero(p, c)}${renderBar(p, c, shown)}${secs}</div>`;
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
      price: Number(p.facts.tuition) || undefined,
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
.pdp{--pdp-topaz:#55bbd2;--pdp-topaz-dk:#1f6b7c;--pdp-teal:#288195;--pdp-green:#81c243;--pdp-ink:#2f2f2f;--pdp-body:#4a4a4a;--pdp-muted:#5b6166;--pdp-line:#dfe5e8;--pdp-soft:#f3f8f9;--pdp-sand:#faf7f2;--pdp-sticky-top:0px;
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
.pdp-hero__img{width:100%;height:100%;object-fit:cover}
.pdp-hero--img::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,22,28,.78) 0%,rgba(8,22,28,.45) 45%,rgba(8,22,28,.05) 75%),linear-gradient(180deg,rgba(8,22,28,0) 50%,rgba(8,22,28,.55) 100%);pointer-events:none}
.pdp-hero--img .pdp-hero__inner{text-shadow:0 1px 12px rgba(0,0,0,.35)}
.pdp-hero__inner{position:relative;z-index:1;width:100%;padding-top:120px;padding-bottom:56px;display:flex;flex-direction:column;gap:18px}
.pdp-hero__intro{font-size:19px;max-width:58ch;color:#fff}
.pdp-hero__ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px}
.pdp-hero__review{font-size:14px}
.pdp-hero__reviewlink{color:#fff!important;text-decoration:underline;text-underline-offset:3px}
.pdp-facts{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));background:#fff;border:1px solid var(--pdp-line);border-radius:16px;margin-top:-36px;position:relative;z-index:2;box-shadow:0 8px 30px rgba(20,40,50,.08);overflow:hidden}
.pdp-fact{padding:18px 18px;border-right:1px solid var(--pdp-line);display:flex;flex-direction:column;gap:2px}
.pdp-fact:last-child{border-right:0}
.pdp-fact__label{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pdp-muted)}
.pdp-fact strong{color:var(--pdp-ink);font-size:16px;line-height:1.35}
.pdp-fact__sub{font-size:13px;color:var(--pdp-muted)}
/* sticky bar */
.pdp-bar{position:sticky;top:var(--pdp-sticky-top);z-index:20;background:rgba(255,255,255,.96);backdrop-filter:saturate(1.4) blur(6px);border-bottom:1px solid var(--pdp-line);margin-top:28px}
.pdp-bar__inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;flex-wrap:wrap;padding-top:8px;padding-bottom:8px}
.pdp-bar__nav{display:flex;gap:22px;align-items:center;flex-wrap:wrap;font-size:14px}
.pdp-bar__nav strong{color:var(--pdp-ink);font-size:15px}
.pdp-bar__nav a{color:var(--pdp-body);text-decoration:none;font-weight:500}
.pdp-bar__nav a:hover{color:var(--pdp-teal)}
.pdp-bar__cta{display:flex;gap:14px;align-items:center}
.pdp-bar__meta{font-size:14px;color:var(--pdp-muted)}
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
.pdp-quote p{font-family:'DM Serif Display',Georgia,serif;font-size:21px;line-height:1.4;color:var(--pdp-ink)}
.pdp-quote footer{margin-top:12px;font-size:14px;color:var(--pdp-muted);font-weight:500}
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
@media (max-width:900px){
  .pdp-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pdp-fact{border-bottom:1px solid var(--pdp-line)}
  .pdp-fact:nth-child(2n){border-right:0}
  .pdp-week__body{grid-template-columns:1fr;padding:0 22px 22px}
  .pdp-bar__nav a{display:none}
}
@media (max-width:640px){
  .pdp-sec{padding:44px 0}
  .pdp-hero{min-height:460px}
  .pdp-hero__inner{padding-top:96px;padding-bottom:52px}
  .pdp-hero__intro{font-size:17px}
  .pdp-date{grid-template-columns:1fr auto;padding:16px}
  .pdp-date .pdp-btn{grid-column:1/-1}
  .pdp-cta{padding:32px 24px}
  .pdp-split{grid-template-columns:1fr}
  .pdp-bar__meta{display:none}
  .pdp-bar__inner{min-height:56px}
}
`;
