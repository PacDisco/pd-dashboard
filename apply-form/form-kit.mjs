// form-kit.mjs — the Pacific Discovery application form engine.
//
// ONE file, used in three places so they can never disagree:
//   - pd-apply/public          the public form renders + validates with it
//   - pd-apply functions       the server re-validates every step with it and
//                              builds the Jotform-shaped records the portals read
//   - pd-dashboard/apply-form  pinned copy for the editor's live preview
//                              (scripts/sync-form-kit.mjs keeps it in step)
//
// The first half is pure logic (no DOM). The renderer at the bottom only runs
// in a browser.
//
// ── Schema shape (edited in the dashboard, stored in Neon apply_forms) ─────
// {
//   settings: { appFee, cardFeeRate, currency, meetingUrl, allowSkipInterview,
//               jotform: { step1: "<formId>", step2: "<formId>" }, texts: {...} },
//   programs: [{ name, type: "semester"|"mini"|"summer", price, pdProgram, active }],
//   terms:    [{ label: "Spring 2027", season: "Spring", year: 2027, active }],
//   lists:    { countries: [...] },
//   steps: [{ key: "step1"|"step2", title, intro, submitLabel,
//             sections: [{ key, title, intro, fields: [Field] }] }]
// }
// Field:
// { key, qid, type, label, help?, placeholder?, required?, hidden?, sensitive?,
//   width?: "half", options?: [...], optionsFrom?: "programs"|"terms"|"countries",
//   showIf?: { match: "any"|"all", rules: [{ field, op, value }] },
//   source?: "query:<param>" | "pageUrl" | "computed:dealAmount" | "copy:<key>:text",
//   accept?, maxMb?,                                  (file)
//   jf?: { name, type, forms: ["step1","step2"], summerQid?, summerName?, mirror? },
//   hubspot?: { contact?: "prop" | { first, last }, deal?: "prop" } }

export const KIT_VERSION = 1;

export const FIELD_TYPES = {
  text:     { label: 'Short text',      jf: 'control_textbox' },
  textarea: { label: 'Long text',       jf: 'control_textarea' },
  email:    { label: 'Email',           jf: 'control_email' },
  phone:    { label: 'Phone',           jf: 'control_phone' },
  number:   { label: 'Number',          jf: 'control_number' },
  date:     { label: 'Date',            jf: 'control_datetime' },
  fullname: { label: 'Full name',       jf: 'control_fullname' },
  address:  { label: 'Address',         jf: 'control_address' },
  select:   { label: 'Dropdown',        jf: 'control_dropdown', options: true },
  radio:    { label: 'Single choice',   jf: 'control_radio',    options: true },
  checkbox: { label: 'Multiple choice', jf: 'control_checkbox', options: true },
  file:     { label: 'File upload',     jf: 'control_fileupload' },
  html:     { label: 'Text / note',     jf: null },
  hidden:   { label: 'Hidden value',    jf: 'control_textbox' },
};

export const OPS = {
  equals: 'is', notEquals: 'is not', isFilled: 'is filled in', isEmpty: 'is empty', contains: 'contains',
};

const ADDRESS_PARTS = ['addr_line1', 'addr_line2', 'city', 'state', 'postal'];
export const STEP_KEYS = ['step1', 'step2'];

// ── schema traversal ────────────────────────────────────────────────────────

export function getStep(schema, stepKey) {
  return (schema?.steps || []).find((s) => s.key === stepKey) || null;
}

/** Every field with its step + section, in form order. */
export function allFields(schema) {
  const out = [];
  for (const step of schema?.steps || []) {
    for (const section of step.sections || []) {
      for (const field of section.fields || []) out.push({ field, step: step.key, section: section.key });
    }
  }
  return out;
}

export function stepFields(schema, stepKey) {
  return allFields(schema).filter((x) => x.step === stepKey).map((x) => x.field);
}

export function fieldByKey(schema, key) {
  const hit = allFields(schema).find((x) => x.field.key === key);
  return hit ? hit.field : null;
}

export function isInput(field) {
  return field && field.type !== 'html';
}

// ── programs / terms / options ──────────────────────────────────────────────

const norm = (s) => String(s ?? '').trim().toLowerCase();

export function programByName(schema, name) {
  const n = norm(name);
  return (schema?.programs || []).find((p) => norm(p.name) === n) || null;
}

/** Seasons a program type runs in. Summer programs only run in summer. */
export function seasonsFor(type) {
  return type === 'summer' ? ['Summer'] : ['Fall', 'Spring'];
}

export function termsFor(schema, programName) {
  const program = programByName(schema, programName);
  const terms = (schema?.terms || []).filter((t) => t.active !== false);
  if (!program) return terms;
  const seasons = seasonsFor(program.type);
  return terms.filter((t) => seasons.includes(t.season));
}

export function termByLabel(schema, label) {
  const n = norm(label);
  return (schema?.terms || []).find((t) => norm(t.label) === n) || null;
}

export function optionsFor(schema, field, values = {}) {
  switch (field.optionsFrom) {
    case 'programs': return (schema?.programs || []).filter((p) => p.active !== false).map((p) => p.name);
    case 'terms': return termsFor(schema, values.program).map((t) => t.label);
    case 'countries': return schema?.lists?.countries || [];
    default: return Array.isArray(field.options) ? field.options : [];
  }
}

// ── values ──────────────────────────────────────────────────────────────────

export function isEmptyValue(field, v) {
  if (v == null) return true;
  switch (field.type) {
    case 'fullname': return !String(v.first || '').trim() || !String(v.last || '').trim();
    case 'address': return !String(v.addr_line1 || '').trim() || !String(v.city || '').trim();
    case 'phone': return !String(v.number || '').replace(/\D/g, '');
    case 'checkbox': case 'file': return !Array.isArray(v) || v.length === 0;
    default: return String(v).trim() === '';
  }
}

/** A plain-text rendering of a value, for conditions, summaries and HubSpot. */
export function valueText(field, v) {
  if (v == null) return '';
  switch (field.type) {
    case 'fullname': return [v.first, v.last].filter(Boolean).map((s) => String(s).trim()).join(' ');
    case 'address': return [...ADDRESS_PARTS.map((k) => v[k]), v.country].filter(Boolean).join(', ');
    case 'phone': return phoneText(v);
    case 'checkbox': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'file': return Array.isArray(v) ? v.map((f) => f.name).join(', ') : '';
    default: return String(v).trim();
  }
}

export function phoneText(v) {
  if (!v) return '';
  const cc = String(v.cc || '').replace(/\D/g, '');
  const num = String(v.number || '').trim();
  return [cc ? `+${cc}` : '', num].filter(Boolean).join(' ');
}

/** "2008-03-14" → { day:"14", month:"03", year:"2008" } (or null). */
export function splitDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? { year: m[1], month: m[2], day: m[3] } : null;
}

export function dateText(s) {
  const d = splitDate(s);
  return d ? `${d.month}-${d.day}-${d.year}` : '';
}

// ── conditions ──────────────────────────────────────────────────────────────

function ruleTrue(schema, rule, values) {
  const f = fieldByKey(schema, rule.field);
  const raw = values[rule.field];
  const text = f ? valueText(f, raw) : String(raw ?? '');
  const want = norm(rule.value);
  switch (rule.op) {
    case 'equals':
      if (Array.isArray(raw)) return raw.some((x) => norm(x) === want);
      return norm(text) === want;
    case 'notEquals':
      if (Array.isArray(raw)) return !raw.some((x) => norm(x) === want);
      return norm(text) !== want;
    case 'isFilled': return f ? !isEmptyValue(f, raw) : text !== '';
    case 'isEmpty': return f ? isEmptyValue(f, raw) : text === '';
    case 'contains': return norm(text).includes(want);
    default: return false;
  }
}

/**
 * Is a field shown? `hidden` fields never are. A condition that depends on a
 * field which is itself not shown counts as false, so answers left behind in
 * a branch the applicant backed out of never re-surface (or validate).
 */
export function isVisible(schema, field, values, seen = new Set()) {
  if (!field || field.hidden || field.type === 'hidden') return false;
  const cond = field.showIf;
  if (!cond || !Array.isArray(cond.rules) || cond.rules.length === 0) return true;
  if (seen.has(field.key)) return false; // cycle guard
  seen.add(field.key);
  const results = cond.rules.map((r) => {
    const dep = fieldByKey(schema, r.field);
    if (dep && dep.type !== 'hidden' && !isVisible(schema, dep, values, new Set(seen))) return false;
    return ruleTrue(schema, r, values);
  });
  return cond.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

// ── validation ──────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateField(schema, field, v, values) {
  if (!isInput(field) || field.type === 'hidden') return null;
  if (isEmptyValue(field, v)) {
    if (!field.required) return null;
    if (field.type === 'fullname') return 'Please enter a first and last name.';
    if (field.type === 'address') return 'Please enter at least the street address and city.';
    if (field.type === 'file') return 'Please upload a file.';
    return 'This field is required.';
  }
  switch (field.type) {
    case 'email':
      if (!EMAIL_RE.test(String(v).trim())) return 'Please enter a valid email address.';
      break;
    case 'number':
      if (!Number.isFinite(Number(v))) return 'Please enter a number.';
      break;
    case 'date': {
      const d = splitDate(v);
      if (!d) return 'Please enter a valid date.';
      const dt = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() < 1900 || dt.getUTCFullYear() > 2100) return 'Please enter a valid date.';
      break;
    }
    case 'phone': {
      const digits = String(v.number || '').replace(/\D/g, '');
      if (digits.length < 6 || digits.length > 15) return 'Please enter a valid phone number.';
      break;
    }
    case 'select': case 'radio': {
      const opts = optionsFor(schema, field, values).map(norm);
      if (opts.length && !opts.includes(norm(v))) return 'Please choose one of the options.';
      break;
    }
    case 'checkbox': {
      const opts = optionsFor(schema, field, values).map(norm);
      if (opts.length && v.some((x) => !opts.includes(norm(x)))) return 'Please choose from the options.';
      break;
    }
    default: break;
  }
  const text = valueText(field, v);
  if (text.length > (field.type === 'textarea' ? 10000 : 1000)) return 'That answer is too long.';
  return null;
}

/**
 * Validate one step. Returns { ok, errors: {key: message}, clean } where
 * `clean` holds only this step's answers for fields that are visible (plus
 * hidden/system fields), normalised — that is what gets stored.
 */
export function validateStep(schema, stepKey, values) {
  const errors = {};
  const clean = {};
  for (const field of stepFields(schema, stepKey)) {
    if (!isInput(field)) continue;
    const v = values?.[field.key];
    if (field.type === 'hidden') {
      if (v != null && String(v).length <= 2000) clean[field.key] = String(v);
      continue;
    }
    if (!isVisible(schema, field, values || {})) continue;
    const err = validateField(schema, field, v, values || {});
    if (err) { errors[field.key] = err; continue; }
    if (!isEmptyValue(field, v)) clean[field.key] = normalise(field, v);
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

function normalise(field, v) {
  const s = (x) => String(x ?? '').trim();
  switch (field.type) {
    case 'fullname': return { first: s(v.first), last: s(v.last) };
    case 'address': return Object.fromEntries(ADDRESS_PARTS.map((k) => [k, s(v[k])]));
    case 'phone': return { cc: s(v.cc).replace(/\D/g, ''), number: s(v.number) };
    case 'checkbox': return v.map(s);
    case 'file': return v.filter((f) => f && f.id).map((f) => ({ id: s(f.id), name: s(f.name), size: Number(f.size) || 0, type: s(f.type) }));
    case 'email': return s(v).toLowerCase();
    default: return s(v);
  }
}

// ── derived values ──────────────────────────────────────────────────────────

/** Fills `source`-driven hidden fields: deal amount, copied text versions. */
export function computeDerived(schema, values) {
  const out = { ...values };
  for (const { field } of allFields(schema)) {
    const src = field.source || '';
    if (src === 'computed:dealAmount') {
      const p = programByName(schema, out.program);
      out[field.key] = p && p.price != null ? String(p.price) : '';
    } else if (src.startsWith('copy:')) {
      const [, from, fmt] = src.split(':');
      const f = fieldByKey(schema, from);
      const v = out[from];
      if (!f || v == null) continue;
      out[field.key] = fmt === 'text' && f.type === 'date' ? dateText(v) : valueText(f, v);
    }
  }
  return out;
}

/** What the applicant is charged: base fee, card surcharge, total (2 dp). */
export function feeBreakdown(schema) {
  const base = Number(schema?.settings?.appFee ?? 250);
  const rate = Number(schema?.settings?.cardFeeRate ?? 0.035);
  const surcharge = Math.round(base * rate * 100) / 100;
  return { base, rate, surcharge, total: Math.round((base + surcharge) * 100) / 100 };
}

/** Season, year and program type for HubSpot routing. */
export function enrolmentFacts(schema, values) {
  const program = programByName(schema, values.program);
  const term = termByLabel(schema, values.term);
  const [seasonGuess, yearGuess] = String(values.term || '').split(/\s+/);
  return {
    program: values.program || '',
    programType: program?.type || null,
    pdProgram: program?.pdProgram || '',
    price: program?.price ?? null,
    season: term?.season || seasonGuess || null,
    year: term?.year ? String(term.year) : (/^\d{4}$/.test(yearGuess || '') ? yearGuess : null),
  };
}

// ── Jotform shape ───────────────────────────────────────────────────────────
// The portals and dashboards read applications as Jotform submissions
// ({ answers: { qid: { name, text, type, order, answer } } }). pd-apply keeps
// producing that exact shape so every existing reader works unchanged.

function jfQidFor(field, formStep, values, schema) {
  if (field.jf?.summerQid && formStep === 'step1') {
    const p = programByName(schema, values.program);
    if (p?.type === 'summer') return { qid: field.jf.summerQid, name: field.jf.summerName || field.jf.name };
  }
  return { qid: String(field.qid), name: field.jf?.name || field.key };
}

function fieldForms(field, ownStep) {
  return Array.isArray(field.jf?.forms) && field.jf.forms.length ? field.jf.forms : [ownStep];
}

/**
 * Jotform-shaped answer map for one form (step1 or step2).
 * `fileUrl(file)` turns an uploaded-file record into a URL.
 */
export function toJotformAnswers(schema, formStep, values, { fileUrl = (f) => f.url || '' } = {}) {
  const answers = {};
  let order = 0;
  for (const { field, step } of allFields(schema)) {
    if (!isInput(field) || !field.qid) continue;
    order += 1;
    if (!fieldForms(field, step).includes(formStep)) continue;
    const { qid, name } = jfQidFor(field, formStep, values, schema);
    const type = field.jf?.type || FIELD_TYPES[field.type]?.jf || 'control_textbox';
    const entry = { name, text: field.label || field.key, type, order: String(order) };
    const v = values[field.key];
    if (v != null && !(typeof v === 'string' && v === '')) entry.answer = jfAnswer(field, v, fileUrl);
    if (entry.answer !== undefined) entry.prettyFormat = valueText(field, v);
    answers[qid] = entry;
  }
  return answers;
}

function jfAnswer(field, v, fileUrl) {
  switch (field.type) {
    case 'fullname': return { first: v.first || '', last: v.last || '' };
    case 'address': return Object.fromEntries(ADDRESS_PARTS.map((k) => [k, v[k] || '']));
    case 'date': { const d = splitDate(v); return d ? { ...d, datetime: `${v} 00:00:00` } : String(v); }
    case 'phone': return { country: String(v.cc || ''), area: '', phone: String(v.number || ''), full: phoneText(v) };
    case 'checkbox': return Array.isArray(v) ? v : [String(v)];
    case 'file': return (Array.isArray(v) ? v : []).map(fileUrl).filter(Boolean);
    default: return String(v);
  }
}

/** Form-encoded params for POST /form/{id}/submissions (the Jotform mirror). */
export function toJotformParams(schema, formStep, values, { fileUrl } = {}) {
  const params = {};
  for (const { field, step } of allFields(schema)) {
    if (!isInput(field) || !field.qid) continue;
    if (field.jf?.mirror === false) continue;
    if (!fieldForms(field, step).includes(formStep)) continue;
    const v = values[field.key];
    if (v == null || v === '') continue;
    const { qid } = jfQidFor(field, formStep, values, schema);
    const k = `submission[${qid}]`;
    switch (field.type) {
      case 'fullname': params[`${k}[first]`] = v.first || ''; params[`${k}[last]`] = v.last || ''; break;
      case 'address': for (const p of ADDRESS_PARTS) if (v[p]) params[`${k}[${p}]`] = v[p]; break;
      case 'date': { const d = splitDate(v); if (d) { params[`${k}[day]`] = d.day; params[`${k}[month]`] = d.month; params[`${k}[year]`] = d.year; } break; }
      case 'phone': params[`${k}[country]`] = String(v.cc || ''); params[`${k}[area]`] = ''; params[`${k}[phone]`] = String(v.number || ''); params[`${k}[full]`] = phoneText(v); break;
      case 'checkbox': (Array.isArray(v) ? v : [v]).forEach((x, i) => { params[`${k}[${i}]`] = x; }); break;
      case 'file': { const urls = (Array.isArray(v) ? v : []).map(fileUrl || ((f) => f.url)).filter(Boolean); if (urls.length) params[k] = urls.join('\n'); break; }
      default: params[k] = String(v);
    }
  }
  return params;
}

// ── schema checks (editor + server) ─────────────────────────────────────────

/** Problems that would break the form. Returns [{ level, message }]. */
export function lintSchema(schema) {
  const out = [];
  const seenKeys = new Map();
  const seenQids = new Map();
  for (const { field, step } of allFields(schema)) {
    if (!field.key || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key)) out.push({ level: 'error', message: `A field has an invalid key "${field.key}".` });
    if (seenKeys.has(field.key)) out.push({ level: 'error', message: `Two fields share the key "${field.key}".` });
    seenKeys.set(field.key, step);
    if (isInput(field) && field.qid) {
      for (const form of fieldForms(field, step)) {
        const id = `${form}:${field.qid}`;
        if (seenQids.has(id)) out.push({ level: 'error', message: `"${field.label}" and "${seenQids.get(id)}" both use field ID ${field.qid}.` });
        seenQids.set(id, field.label || field.key);
      }
    }
    if (FIELD_TYPES[field.type]?.options && !field.optionsFrom && !(field.options || []).length) {
      out.push({ level: 'error', message: `"${field.label}" has no options.` });
    }
    for (const r of field.showIf?.rules || []) {
      if (!fieldByKey(schema, r.field)) out.push({ level: 'error', message: `"${field.label}" depends on a field that no longer exists (${r.field}).` });
    }
  }
  for (const k of ['name', 'email', 'program', 'term']) {
    if (!seenKeys.has(k)) out.push({ level: 'error', message: `The form must keep the "${k}" field — the flow, HubSpot and the portals rely on it.` });
  }
  for (const p of schema?.programs || []) {
    if (p.active !== false && (p.price == null || p.price === '')) out.push({ level: 'warn', message: `${p.name} has no price, so its deal amount will be blank.` });
    if (p.active !== false && !p.pdProgram) out.push({ level: 'warn', message: `${p.name} has no HubSpot "PD Program" value yet.` });
  }
  return out;
}

/** Next free synthetic field ID for fields that don't exist in Jotform. */
export function nextQid(schema) {
  let max = 999;
  for (const { field } of allFields(schema)) {
    const n = parseInt(field.qid, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

// ── renderer (browser only) ─────────────────────────────────────────────────

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Allow-list sanitiser for the html note fields (bold, links, lists, paras). */
export function safeHtml(html) {
  const allowed = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI', 'SPAN', 'H3', 'H4']);
  if (typeof document === 'undefined') return esc(html);
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  (function walk(node) {
    for (const el of [...node.children]) {
      if (!allowed.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const keep = el.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:)/i.test(a.value);
        if (!keep) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
      walk(el);
    }
  })(tpl.content);
  return tpl.innerHTML;
}

const COMMON_CC = [['1', '+1 US / Canada'], ['64', '+64 New Zealand'], ['61', '+61 Australia'], ['44', '+44 UK'], ['31', '+31 Netherlands'], ['49', '+49 Germany'], ['33', '+33 France'], ['41', '+41 Switzerland'], ['46', '+46 Sweden'], ['47', '+47 Norway'], ['45', '+45 Denmark'], ['34', '+34 Spain'], ['39', '+39 Italy'], ['852', '+852 Hong Kong'], ['65', '+65 Singapore'], ['81', '+81 Japan'], ['82', '+82 South Korea'], ['86', '+86 China'], ['91', '+91 India'], ['52', '+52 Mexico'], ['55', '+55 Brazil'], ['27', '+27 South Africa'], ['971', '+971 UAE']];

/**
 * Render one step into `root`. Returns { values(), validate(), focusFirstError() }.
 *  opts.values       initial answers
 *  opts.onChange     (values) => void
 *  opts.upload       async (file, field) => { id, name, size, type }   (file fields)
 *  opts.preview      true in the dashboard editor (no uploads, marks hidden fields)
 *  opts.onPick       (fieldKey) => void  (editor: click a field to select it)
 */
export function renderStep(root, schema, stepKey, opts = {}) {
  const step = getStep(schema, stepKey);
  const values = { ...(opts.values || {}) };
  const errors = {};
  let uploading = 0;

  root.innerHTML = '';
  root.classList.add('fk');
  if (!step) { root.textContent = 'This step is not set up.'; return null; }

  const fieldEls = new Map();

  for (const section of step.sections || []) {
    const sec = document.createElement('fieldset');
    sec.className = 'fk-section';
    sec.dataset.section = section.key;
    if (section.title) sec.insertAdjacentHTML('beforeend', `<legend class="fk-legend">${esc(section.title)}</legend>`);
    if (section.intro) sec.insertAdjacentHTML('beforeend', `<div class="fk-intro">${safeHtml(section.intro)}</div>`);
    const grid = document.createElement('div');
    grid.className = 'fk-grid';
    for (const field of section.fields || []) {
      if (field.type === 'hidden' && !opts.preview) continue;
      if (field.hidden && !opts.preview) continue;
      const el = buildField(field);
      if (!el) continue;
      grid.appendChild(el);
      fieldEls.set(field.key, el);
    }
    sec.appendChild(grid);
    root.appendChild(sec);
  }

  function buildField(field) {
    const wrap = document.createElement('div');
    wrap.className = `fk-field fk-${field.type}${field.width === 'half' ? ' fk-half' : ''}`;
    wrap.dataset.key = field.key;
    if (opts.preview) {
      wrap.classList.add('fk-pickable');
      if (field.hidden || field.type === 'hidden') wrap.classList.add('fk-ghost');
      wrap.addEventListener('click', (e) => { if (opts.onPick) { e.preventDefault(); opts.onPick(field.key); } }, true);
    }
    if (field.type === 'html') {
      wrap.innerHTML = `<div class="fk-note">${safeHtml(field.html || field.label)}</div>`;
      return wrap;
    }
    if (field.type === 'hidden') {
      wrap.innerHTML = `<div class="fk-hiddenval">Hidden: ${esc(field.label || field.key)} <small>${esc(field.source || '')}</small></div>`;
      return wrap;
    }
    const id = `fk_${field.key}`;
    const req = field.required ? '<span class="fk-req" aria-hidden="true">*</span>' : '';
    const groupish = ['radio', 'checkbox', 'fullname', 'address', 'phone'].includes(field.type);
    const labelHtml = groupish
      ? `<div class="fk-label" id="${id}_lbl">${esc(field.label)}${req}</div>`
      : `<label class="fk-label" for="${id}">${esc(field.label)}${req}</label>`;
    wrap.innerHTML = `${labelHtml}${field.help ? `<div class="fk-help" id="${id}_help">${esc(field.help)}</div>` : ''}<div class="fk-control"></div><div class="fk-error" id="${id}_err" role="alert"></div>`;
    if (groupish) { wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-labelledby', `${id}_lbl`); }
    fillControl(wrap.querySelector('.fk-control'), field, id);
    return wrap;
  }

  function described(field, id) {
    return [field.help ? `${id}_help` : '', `${id}_err`].filter(Boolean).join(' ');
  }

  function fillControl(box, field, id) {
    const v = values[field.key];
    const req = field.required ? ' aria-required="true"' : '';
    const ph = field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : '';
    const db = ` aria-describedby="${described(field, id)}"`;
    const on = (sel, ev, fn) => box.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
    switch (field.type) {
      case 'text': case 'email': case 'number': {
        const t = field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text';
        const ac = field.key === 'email' ? ' autocomplete="email"' : field.key === 'preferredName' ? ' autocomplete="nickname"' : '';
        box.innerHTML = `<input id="${id}" type="${t}"${t === 'number' ? ' inputmode="decimal"' : ''} value="${esc(v ?? '')}"${ph}${req}${db}${ac}>`;
        on('input', 'input', (e) => set(field, e.target.value));
        break;
      }
      case 'textarea':
        box.innerHTML = `<textarea id="${id}" rows="4"${ph}${req}${db}>${esc(v ?? '')}</textarea>`;
        on('textarea', 'input', (e) => set(field, e.target.value));
        break;
      case 'date':
        box.innerHTML = `<input id="${id}" type="date" value="${esc(v ?? '')}"${req}${db}${field.key === 'dob' ? ' autocomplete="bday" max="' + new Date().toISOString().slice(0, 10) + '"' : ''}>`;
        on('input', 'change', (e) => set(field, e.target.value));
        on('input', 'input', (e) => set(field, e.target.value, true));
        break;
      case 'select': {
        const options = optionsFor(schema, field, values);
        box.innerHTML = `<select id="${id}"${req}${db}><option value="">Please select</option>${options.map((o) => `<option${norm(o) === norm(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        on('select', 'change', (e) => set(field, e.target.value));
        break;
      }
      case 'radio': {
        const options = optionsFor(schema, field, values);
        box.innerHTML = `<div class="fk-choices">${options.map((o, i) => `<label class="fk-choice"><input type="radio" name="${id}" id="${id}_${i}" value="${esc(o)}"${norm(o) === norm(v) ? ' checked' : ''}${db}><span>${esc(o)}</span></label>`).join('')}</div>`;
        on('input', 'change', (e) => set(field, e.target.value));
        break;
      }
      case 'checkbox': {
        const options = optionsFor(schema, field, values);
        const cur = new Set((Array.isArray(v) ? v : []).map(norm));
        box.innerHTML = `<div class="fk-choices">${options.map((o, i) => `<label class="fk-choice"><input type="checkbox" id="${id}_${i}" value="${esc(o)}"${cur.has(norm(o)) ? ' checked' : ''}${db}><span>${esc(o)}</span></label>`).join('')}</div>`;
        on('input', 'change', () => set(field, [...box.querySelectorAll('input:checked')].map((x) => x.value)));
        break;
      }
      case 'fullname': {
        const n = v || {};
        box.innerHTML = `<div class="fk-row"><div class="fk-sub"><input id="${id}" autocomplete="given-name" value="${esc(n.first || '')}" aria-label="First name"${req}${db}><small>First name</small></div><div class="fk-sub"><input id="${id}_last" autocomplete="family-name" value="${esc(n.last || '')}" aria-label="Last name"${req}${db}><small>Last name</small></div></div>`;
        on('input', 'input', () => set(field, { first: box.querySelector(`#${id}`).value, last: box.querySelector(`#${id}_last`).value }));
        break;
      }
      case 'address': {
        const a = v || {};
        const part = (k, label, ac, cls = '') => `<div class="fk-sub ${cls}"><input data-part="${k}" id="${id}_${k}" autocomplete="${ac}" value="${esc(a[k] || '')}" aria-label="${label}"${db}><small>${label}</small></div>`;
        box.innerHTML = `<div class="fk-addr">${part('addr_line1', 'Street address', 'address-line1', 'fk-wide')}${part('addr_line2', 'Street address line 2', 'address-line2', 'fk-wide')}${part('city', 'City', 'address-level2')}${part('state', 'State / Province', 'address-level1')}${part('postal', 'Postal / Zip code', 'postal-code')}</div>`;
        on('input', 'input', () => {
          const next = {};
          box.querySelectorAll('[data-part]').forEach((el) => { next[el.dataset.part] = el.value; });
          set(field, next);
        });
        break;
      }
      case 'phone': {
        const p = v || { cc: '1', number: '' };
        const known = COMMON_CC.some(([c]) => c === String(p.cc));
        box.innerHTML = `<div class="fk-row fk-phone"><div class="fk-sub fk-cc"><select id="${id}_cc" aria-label="Country code">${COMMON_CC.map(([c, l]) => `<option value="${c}"${c === String(p.cc) ? ' selected' : ''}>${esc(l)}</option>`).join('')}<option value="other"${!known && p.cc ? ' selected' : ''}>Other…</option></select><input class="fk-ccother${!known && p.cc ? '' : ' fk-hide'}" id="${id}_ccx" inputmode="numeric" value="${esc(!known ? p.cc || '' : '')}" aria-label="Other country code" placeholder="Code"></div><div class="fk-sub fk-wide"><input id="${id}" type="tel" autocomplete="tel-national" value="${esc(p.number || '')}" aria-label="Phone number"${req}${db}></div></div>`;
        const read = () => {
          const sel = box.querySelector(`#${id}_cc`).value;
          const other = box.querySelector(`#${id}_ccx`);
          other.classList.toggle('fk-hide', sel !== 'other');
          return { cc: sel === 'other' ? other.value.replace(/\D/g, '') : sel, number: box.querySelector(`#${id}`).value };
        };
        on('select,input', 'input', () => set(field, read()));
        on('select', 'change', () => set(field, read()));
        break;
      }
      case 'file': {
        const files = Array.isArray(v) ? v : [];
        const max = Number(field.maxMb || 10);
        box.innerHTML = `<div class="fk-file"><input id="${id}" type="file" accept="${esc(field.accept || '')}"${db}${opts.preview ? ' disabled' : ''}><div class="fk-files">${files.map((f) => `<div class="fk-filechip">✓ ${esc(f.name)}</div>`).join('')}</div><small>Max ${max} MB.</small></div>`;
        on('input', 'change', async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const list = box.querySelector('.fk-files');
          if (file.size > max * 1024 * 1024) { showError(field.key, `That file is larger than ${max} MB.`); e.target.value = ''; return; }
          if (!opts.upload) return;
          showError(field.key, '');
          list.innerHTML = `<div class="fk-filechip fk-busy">Uploading ${esc(file.name)}…</div>`;
          uploading += 1;
          try {
            const rec = await opts.upload(file, field);
            set(field, [rec]);
            list.innerHTML = `<div class="fk-filechip">✓ ${esc(rec.name)}</div>`;
          } catch (err) {
            list.innerHTML = '';
            e.target.value = '';
            showError(field.key, err.message || 'Upload failed — please try again.');
          } finally { uploading -= 1; }
        });
        break;
      }
      default: break;
    }
  }

  function set(field, v, quiet = false) {
    values[field.key] = v;
    if (errors[field.key]) {
      const err = validateField(schema, field, v, values);
      showError(field.key, err || '');
    }
    if (!quiet) refresh(field.key);
    opts.onChange?.(values);
  }

  function showError(key, msg) {
    const el = fieldEls.get(key);
    if (!el) return;
    if (msg) errors[key] = msg; else delete errors[key];
    el.classList.toggle('fk-invalid', !!msg);
    const box = el.querySelector('.fk-error');
    if (box) box.textContent = msg || '';
    el.querySelectorAll('input,select,textarea').forEach((i) => i.setAttribute('aria-invalid', msg ? 'true' : 'false'));
  }

  function refresh(changedKey) {
    for (const { field } of allFields(schema)) {
      const el = fieldEls.get(field.key);
      if (!el) continue;
      // dependent option lists (term depends on program)
      if (changedKey && field.optionsFrom === 'terms' && changedKey === 'program') {
        const opts2 = optionsFor(schema, field, values);
        if (values[field.key] && !opts2.map(norm).includes(norm(values[field.key]))) values[field.key] = '';
        const box = el.querySelector('.fk-control');
        fillControl(box, field, `fk_${field.key}`);
      }
      if (opts.preview && (field.hidden || field.type === 'hidden')) continue;
      el.classList.toggle('fk-hide', !isVisible(schema, field, values));
    }
  }

  refresh();

  return {
    values: () => ({ ...values }),
    busy: () => uploading > 0,
    setErrors(map) {
      for (const key of fieldEls.keys()) showError(key, map?.[key] || '');
    },
    validate() {
      const res = validateStep(schema, stepKey, values);
      for (const key of fieldEls.keys()) showError(key, res.errors[key] || '');
      return res;
    },
    focusFirstError() {
      for (const [key, el] of fieldEls) {
        if (errors[key]) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.querySelector('input,select,textarea')?.focus({ preventScroll: true });
          return;
        }
      }
    },
    highlight(key) {
      for (const [k, el] of fieldEls) el.classList.toggle('fk-picked', k === key);
      fieldEls.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  };
}

/** Base styles for the form (both the public page and the editor preview). */
export const FORM_CSS = `
.fk{--fk-ink:#2f2f2f;--fk-body:#4a4a4a;--fk-muted:#5f666b;--fk-line:#cfd7da;--fk-accent:#288195;--fk-accent-soft:#e3f4f8;--fk-bad:#a8321d;--fk-bad-bg:#fdecea;--fk-bg:#fff}
.fk-section{border:0;margin:0 0 28px;padding:0;min-width:0}
.fk-legend{font-family:'DM Serif Display',Georgia,serif;font-size:24px;color:var(--fk-ink);padding:0;margin:0 0 6px}
.fk-intro{color:var(--fk-muted);margin:0 0 14px}
.fk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 18px}
.fk-field{grid-column:1/-1;margin:0 0 16px;min-width:0}
.fk-half{grid-column:span 1}
@media (max-width:640px){.fk-grid{grid-template-columns:1fr}.fk-half{grid-column:1/-1}}
.fk-label{display:block;font-weight:600;color:var(--fk-ink);margin:0 0 6px;font-size:15px}
.fk-req{color:var(--fk-bad);margin-left:3px}
.fk-help{font-size:13px;color:var(--fk-muted);margin:-2px 0 8px}
.fk input:not([type=radio]):not([type=checkbox]):not([type=file]),.fk select,.fk textarea{width:100%;min-height:46px;border:1px solid var(--fk-line);border-radius:10px;padding:10px 12px;background:var(--fk-bg);font:inherit;font-size:16px;color:var(--fk-ink)}
.fk textarea{min-height:110px;resize:vertical}
.fk input:focus,.fk select:focus,.fk textarea:focus{outline:3px solid rgba(85,187,210,.45);outline-offset:1px;border-color:var(--fk-accent)}
.fk-row{display:flex;gap:12px;flex-wrap:wrap}
.fk-sub{flex:1 1 160px;min-width:0}
.fk-sub small,.fk-file small{display:block;color:var(--fk-muted);font-size:12px;margin-top:4px}
.fk-addr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px}
.fk-addr .fk-wide{grid-column:1/-1}
@media (max-width:640px){.fk-addr{grid-template-columns:1fr}}
.fk-phone{flex-wrap:nowrap}
.fk-phone .fk-cc{flex:0 0 auto;width:min(46%,190px);display:flex;gap:6px}
.fk-phone .fk-cc select{padding-right:4px}
.fk-phone .fk-ccother{max-width:72px}
.fk-phone .fk-wide{flex:1 1 0;min-width:0}
.fk-choices{display:flex;flex-wrap:wrap;gap:8px}
.fk-choice{display:inline-flex;align-items:center;gap:10px;min-height:46px;padding:8px 14px;border:1px solid var(--fk-line);border-radius:10px;cursor:pointer;background:var(--fk-bg)}
.fk-choice:has(input:checked){border-color:var(--fk-accent);background:var(--fk-accent-soft)}
.fk-choice input{width:18px;height:18px;accent-color:var(--fk-accent);margin:0}
.fk-note{background:#f5fbfc;border-left:3px solid var(--fk-accent);padding:12px 14px;border-radius:6px;color:var(--fk-body)}
.fk-note p{margin:0 0 6px}.fk-note p:last-child{margin:0}
.fk-error{color:var(--fk-bad);font-size:13px;font-weight:500;min-height:0;margin-top:4px}
.fk-error:empty{display:none}
.fk-invalid input,.fk-invalid select,.fk-invalid textarea,.fk-invalid .fk-choice{border-color:var(--fk-bad)!important}
.fk-hide{display:none!important}
.fk-filechip{display:inline-block;margin-top:8px;padding:6px 10px;border-radius:8px;background:var(--fk-accent-soft);color:var(--fk-accent);font-size:13px;font-weight:600}
.fk-busy{background:#f1f3f4;color:var(--fk-muted)}
.fk-pickable{cursor:pointer;border-radius:10px;outline:1px dashed transparent;outline-offset:6px}
.fk-pickable:hover{outline-color:#b9d9e2}
.fk-picked{outline:2px solid var(--fk-accent)!important}
.fk-ghost{opacity:.55}
.fk-hiddenval{font-size:13px;color:var(--fk-muted);border:1px dashed var(--fk-line);border-radius:8px;padding:8px 10px}
`;
