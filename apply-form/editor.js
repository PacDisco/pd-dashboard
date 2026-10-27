// apply-form/editor.js — editor for the online application (pd-apply).
//
// The form is ONE JSON document (see the schema notes at the top of
// form-kit.mjs). Every change autosaves as a draft to /api/apply-forms;
// applicants only see it after Publish. The preview is rendered by the same
// form-kit.mjs the public site uses (pinned copy in this folder — keep it in
// step with pd-apply/public/form-kit.mjs).

import {
  renderStep, FORM_CSS, FIELD_TYPES, OPS, allFields, fieldByKey, lintSchema, nextQid, optionsFor, esc,
} from '/apply-form/form-kit.mjs';
import {
  termsToHtml, DEFAULT_FEE_POLICY, DEFAULT_EMAILS, EMAIL_PLACEHOLDERS, FEE_REMINDER_DAYS, FEE_CLOSE_DAYS,
  DEFAULT_ADVISOR_URL, DEFAULT_ADVISOR_TEXT,
} from '/apply-form/terms-kit.mjs';

const API = '/api/apply-forms';
const SAVE_DELAY = 1200;
const CORE_KEYS = new Set(['name', 'email', 'program', 'term', 'dob', 'mobile', 'preferredName']);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  user: null, form: null, draft: null, rev: 0, lint: [], applySite: null,
  tab: 'fields', step: 'step1', sel: null, hubspot: null,
  saveTimer: null, saving: false, dirty: false, saveError: null,
  apps: { status: '', q: '', list: [], counts: {} },
  terms: null, // { title, draft, live, versions, dirty, saving, timer }
};

// ── api ─────────────────────────────────────────────────────────────────────
async function api(method, params = {}, body) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`, {
    method, credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) notice('bad', 'Your sign-in has expired. <a href="/" target="_blank" rel="noopener">Sign in again in a new tab</a>, then come back — your changes are kept here.');
  if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; e.body = data; throw e; }
  return data;
}

function toast(html, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status'); el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function notice(kind, html) {
  $('#notices').innerHTML = html ? `<div class="notice notice--${kind}">${html}</div>` : '';
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── save / publish ──────────────────────────────────────────────────────────
function changed({ rerender = true } = {}) {
  S.dirty = true;
  S.lint = lintSchema(S.draft);
  setSaveState('Unsaved changes');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, SAVE_DELAY);
  if (rerender) render();
  else updateChrome();
}

async function save() {
  if (S.saving) { S.saveTimer = setTimeout(save, 400); return; }
  if (!S.dirty) return;
  S.saving = true; S.dirty = false;
  setSaveState('Saving…');
  try {
    const out = await api('POST', {}, { action: 'save', rev: S.rev, draft: S.draft });
    S.rev = out.rev; S.form.changes = true; S.form.draftRev = out.rev; S.saveError = null;
    setSaveState('Saved');
  } catch (err) {
    S.dirty = true; S.saveError = err.message;
    if (err.status === 409) {
      notice('bad', `Someone else changed the form${err.body?.conflict?.by ? ` (${esc(err.body.conflict.by)})` : ''}. <button class="btn btn--sm" id="reload">Reload their version</button> — your unsaved edits here will be lost.`);
      $('#reload')?.addEventListener('click', () => location.reload());
    }
    setSaveState(`Not saved — ${err.message}`, true);
  } finally { S.saving = false; updateChrome(); }
}

function setSaveState(t, err = false) {
  const el = $('#save-state');
  el.textContent = t; el.classList.toggle('err', err);
}

function updateChrome() {
  const f = S.form;
  const chip = $('#status-chip');
  if (!f?.publishedRev) chip.innerHTML = '<span class="chip chip--draft">Not published yet</span>';
  else if (f.changes || S.dirty) chip.innerHTML = '<span class="chip chip--changes">Unpublished changes</span>';
  else chip.innerHTML = '<span class="chip chip--live">Live</span>';
  $('#btn-discard').classList.toggle('hidden', !(f?.publishedRev && f.changes));
  const errs = S.lint.filter((l) => l.level === 'error').length;
  const pub = $('#btn-publish');
  pub.disabled = !S.user?.canPublish || errs > 0;
  pub.title = !S.user?.canPublish ? 'You can edit, but publishing needs an admin or admissions lead.' : errs ? 'Fix the problems listed in the Form fields tab first.' : 'Make these changes live for applicants';
  const live = $('#open-live');
  if (S.applySite) live.href = S.applySite; else live.classList.add('hidden');
  const pv = $('#open-preview');
  if (S.applySite) pv.href = `${S.applySite}/?preview=1`; else pv.classList.add('hidden');
}

async function publish() {
  clearTimeout(S.saveTimer);
  await save();
  if (S.dirty || S.saveError) { toast('Save failed — fix that first.'); return; }
  const note = await promptDialog('Publish the form', 'Applicants will see these changes within about 30 seconds. Add a short note so others know what changed (optional).', 'e.g. Added Japan Summer price');
  if (note === null) return;
  try {
    await api('POST', {}, { action: 'publish', rev: S.rev, note });
    S.form.publishedRev = S.rev; S.form.changes = false; S.form.publishedAt = new Date().toISOString();
    updateChrome();
    notice('', '');
    toast('Published — live on the application within about 30 seconds.');
  } catch (err) { toast(esc(err.message), 7000); }
}

async function discard() {
  if (!(await confirmDialog('Discard changes?', 'The draft goes back to what applicants currently see. This can\'t be undone.'))) return;
  try {
    const out = await api('POST', {}, { action: 'discard' });
    loadForm(out.form, out.lint);
    render(); toast('Changes discarded.');
  } catch (err) { toast(esc(err.message)); }
}

// ── dialogs ─────────────────────────────────────────────────────────────────
function openDialog(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  d.showModal();
  return d;
}
function confirmDialog(title, body, okLabel = 'Yes, continue', danger = true) {
  return new Promise((resolve) => {
    const d = openDialog(`<div class="dlg-head"><h2 class="serif">${esc(title)}</h2></div><div class="dlg-body"><p>${esc(body)}</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(okLabel)}</button></div></div>`);
    d.querySelector('[data-x]').onclick = () => { d.close(); resolve(false); };
    d.querySelector('[data-ok]').onclick = () => { d.close(); resolve(true); };
    d.onclose = () => resolve(false);
  });
}
function promptDialog(title, body, placeholder) {
  return new Promise((resolve) => {
    const d = openDialog(`<div class="dlg-head"><h2 class="serif">${esc(title)}</h2></div><div class="dlg-body"><p>${esc(body)}</p><div class="field"><input type="text" id="pd-in" placeholder="${esc(placeholder || '')}" maxlength="300"></div><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn btn--primary" data-ok>Publish</button></div></div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    d.querySelector('[data-x]').onclick = () => finish(null);
    d.querySelector('[data-ok]').onclick = () => finish(d.querySelector('#pd-in').value.trim());
    d.querySelector('#pd-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(e.target.value.trim()); });
    d.onclose = () => finish(null);
    d.querySelector('#pd-in').focus();
  });
}

async function showVersions() {
  const { versions } = await api('GET', { action: 'versions' });
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Published versions</h2><button class="btn btn--sm" data-x>Close</button></div>
    <div class="dlg-body">${versions.length ? versions.map((v) => `<div class="panel" style="padding:12px;margin-bottom:8px"><strong>${v.kind === 'publish' ? 'Published' : 'Restored'}</strong> · ${new Date(v.created_at).toLocaleString()} · ${esc(v.created_by || '')}<div class="em">${esc(v.note || '')}</div><button class="btn btn--sm" data-restore="${v.id}" style="margin-top:6px">Restore into draft</button></div>`).join('') : '<p>No versions yet — publish to create one.</p>'}</div>`);
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const out = await api('POST', {}, { action: 'restore', versionId: b.dataset.restore });
      d.close(); loadForm(out.form, out.lint); render();
      toast('Restored into the draft. Publish to make it live.');
    } catch (err) { toast(esc(err.message)); }
  }));
}

// ── tabs ────────────────────────────────────────────────────────────────────
function render() {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  updateChrome();
  if (S.tab === 'fields') return renderFields();
  if (S.tab === 'programs') return renderPrograms();
  if (S.tab === 'settings') return renderSettings();
  if (S.tab === 'apps') return renderApps();
  if (S.tab === 'terms') return renderTerms();
}

// ── tab: fields ─────────────────────────────────────────────────────────────
let preview = null;

function stepObj() { return S.draft.steps.find((s) => s.key === S.step); }

function locate(key) {
  for (const st of S.draft.steps) {
    for (const sec of st.sections) {
      const i = sec.fields.findIndex((f) => f.key === key);
      if (i >= 0) return { step: st, section: sec, index: i, field: sec.fields[i] };
    }
  }
  return null;
}

function renderFields() {
  $('#app').innerHTML = `<div class="work"><div class="canvas"><div class="stepbar">
      <div class="seg" role="group" aria-label="Step"><button data-step="step1" aria-pressed="${S.step === 'step1'}">Step 1 · About you</button><button data-step="step2" aria-pressed="${S.step === 'step2'}">Step 2 · Application</button></div>
      <span class="em">Click a field to edit it. Faded fields are hidden from applicants.</span></div>
      <div class="sheet"><div id="pv"></div></div></div>
    <aside class="inspector" id="insp"></aside></div>`;
  $$('.seg [data-step]').forEach((b) => b.addEventListener('click', () => { S.step = b.dataset.step; S.sel = null; renderFields(); }));
  preview = renderStep($('#pv'), S.draft, S.step, { preview: true, values: {}, onPick: (k) => { S.sel = k; renderInspector(); preview.highlight(k); } });
  renderInspector();
  if (S.sel) preview?.highlight(S.sel);
}

function renderInspector() {
  const box = $('#insp');
  if (!box) return;
  const loc = S.sel ? locate(S.sel) : null;
  if (loc) return renderFieldEditor(box, loc);
  const st = stepObj();
  const errs = S.lint.filter((l) => l.level === 'error');
  const warns = S.lint.filter((l) => l.level === 'warn');
  box.innerHTML = `<div class="insp-head"><h2>${esc(st.title || st.key)}</h2><button class="btn btn--sm" id="add-sec">+ Section</button></div>
    <div class="insp-body">
      ${errs.length ? `<div class="lint lint--error"><strong>Fix before publishing</strong><ul>${errs.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>` : ''}
      ${warns.length ? `<details class="lint lint--warn"><summary>${warns.length} thing${warns.length > 1 ? 's' : ''} to check</summary><ul>${warns.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></details>` : ''}
      <div class="field"><label for="st-title">Step title</label><input type="text" id="st-title" value="${esc(st.title || '')}"></div>
      <div class="field"><label for="st-intro">Intro text <span class="help">(optional, shown under the title)</span></label><textarea id="st-intro" rows="2">${esc(st.intro || '')}</textarea></div>
      <div class="field"><label for="st-submit">Button text</label><input type="text" id="st-submit" value="${esc(st.submitLabel || '')}"></div>
      ${st.sections.map((sec, si) => `<div class="sec" data-sec="${si}">
        <div class="sec__head"><span class="t" data-edit-sec="${si}" title="Rename section">${esc(sec.title || '(untitled section)')}</span>
          <button class="btn btn--icon btn--sm" data-sec-up="${si}" aria-label="Move section up" ${si === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn--icon btn--sm" data-sec-down="${si}" aria-label="Move section down" ${si === st.sections.length - 1 ? 'disabled' : ''}>↓</button></div>
        ${sec.fields.map((f, fi) => `<div class="frow${f.hidden || f.type === 'hidden' ? ' off' : ''}">
          <span class="t" data-pick="${esc(f.key)}">${esc(f.label || (f.type === 'html' ? 'Text block' : f.key))}</span>
          ${f.required && f.type !== 'hidden' ? '<span class="tag req" title="Required">*</span>' : ''}
          ${f.showIf?.rules?.length ? '<span class="tag if" title="Only shown when a condition is met">if</span>' : ''}
          <span class="ty">${esc(FIELD_TYPES[f.type]?.label || f.type)}</span>
          <button class="btn btn--icon btn--sm" data-up="${si}:${fi}" aria-label="Move up" ${fi === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn--icon btn--sm" data-down="${si}:${fi}" aria-label="Move down" ${fi === sec.fields.length - 1 ? 'disabled' : ''}>↓</button>
        </div>`).join('')}
        <div class="addrow"><button class="btn btn--sm" data-add="${si}">+ Add field</button></div>
      </div>`).join('')}
    </div>`;
  const bind = (id, k) => $(id, box).addEventListener('input', (e) => { st[k] = e.target.value; changed({ rerender: false }); });
  bind('#st-title', 'title'); bind('#st-intro', 'intro'); bind('#st-submit', 'submitLabel');
  $$('[data-pick]', box).forEach((el) => el.addEventListener('click', () => { S.sel = el.dataset.pick; renderInspector(); preview?.highlight(S.sel); }));
  const move = (arr, i, d) => { const [x] = arr.splice(i, 1); arr.splice(i + d, 0, x); };
  $$('[data-up],[data-down]', box).forEach((b) => b.addEventListener('click', () => {
    const [si, fi] = (b.dataset.up || b.dataset.down).split(':').map(Number);
    move(st.sections[si].fields, fi, b.dataset.up ? -1 : 1); changed();
  }));
  $$('[data-sec-up],[data-sec-down]', box).forEach((b) => b.addEventListener('click', () => {
    const si = Number(b.dataset.secUp ?? b.dataset.secDown);
    move(st.sections, si, b.dataset.secUp !== undefined ? -1 : 1); changed();
  }));
  $$('[data-edit-sec]', box).forEach((el) => el.addEventListener('click', () => editSection(st.sections[Number(el.dataset.editSec)], st)));
  $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => addField(st.sections[Number(b.dataset.add)])));
  $('#add-sec', box).addEventListener('click', () => {
    st.sections.push({ key: uniqueKey('section'), title: 'New section', intro: '', fields: [] });
    changed();
  });
}

function editSection(sec, st) {
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Section</h2><button class="btn btn--sm" data-x>Done</button></div><div class="dlg-body">
    <div class="field"><label for="sec-t">Title</label><input type="text" id="sec-t" value="${esc(sec.title || '')}"></div>
    <div class="field"><label for="sec-i">Intro <span class="help">(optional)</span></label><textarea id="sec-i">${esc(sec.intro || '')}</textarea></div>
    <div class="acts"><button class="btn btn--danger" id="sec-del" ${sec.fields.length ? 'disabled title="Move or delete its fields first"' : ''}>Delete section</button></div></div>`);
  d.querySelector('#sec-t').addEventListener('input', (e) => { sec.title = e.target.value; changed({ rerender: false }); });
  d.querySelector('#sec-i').addEventListener('input', (e) => { sec.intro = e.target.value; changed({ rerender: false }); });
  d.querySelector('#sec-del').addEventListener('click', () => { st.sections.splice(st.sections.indexOf(sec), 1); d.close(); changed(); });
  d.querySelector('[data-x]').onclick = () => d.close();
  d.onclose = () => render();
}

function uniqueKey(base) {
  const keys = new Set(allFields(S.draft).map((x) => x.field.key));
  for (const st of S.draft.steps) for (const s of st.sections) keys.add(s.key);
  let k = base.replace(/[^A-Za-z0-9_]/g, '') || 'field';
  if (!/^[A-Za-z]/.test(k)) k = `f${k}`;
  let n = 2; let out = k;
  while (keys.has(out)) out = `${k}${n++}`;
  return out;
}

function camel(label) {
  const words = String(label).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 4);
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('') || 'field';
}

function addField(section) {
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Add a field</h2><button class="btn btn--sm" data-x>Cancel</button></div><div class="dlg-body">
    <div class="field"><label for="nf-label">Question / label</label><input type="text" id="nf-label" placeholder="e.g. Do you have any food allergies?"></div>
    <div class="field"><label for="nf-type">Type</label><select id="nf-type">${Object.entries(FIELD_TYPES).filter(([k]) => k !== 'hidden').map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
    <div class="field" id="nf-opts-wrap"><label for="nf-opts">Options <span class="help">(one per line)</span></label><textarea id="nf-opts" rows="4">Yes\nNo</textarea></div>
    <label class="check"><input type="checkbox" id="nf-req"> Required</label>
    <div class="acts"><button class="btn btn--primary" id="nf-ok">Add field</button></div></div>`);
  const typeSel = d.querySelector('#nf-type');
  const syncOpts = () => d.querySelector('#nf-opts-wrap').classList.toggle('hidden', !FIELD_TYPES[typeSel.value]?.options);
  typeSel.addEventListener('change', syncOpts); typeSel.value = 'text'; syncOpts();
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('#nf-ok').addEventListener('click', () => {
    const label = d.querySelector('#nf-label').value.trim();
    if (!label && typeSel.value !== 'html') { d.querySelector('#nf-label').focus(); return; }
    const type = typeSel.value;
    const key = uniqueKey(camel(label || 'note'));
    const f = { key, type, label: type === 'html' ? '' : label, required: d.querySelector('#nf-req').checked };
    if (type === 'html') f.html = `<p>${esc(label || 'New text')}</p>`;
    else { f.qid = nextQid(S.draft); f.jf = { name: key, type: FIELD_TYPES[type].jf, forms: [S.step], mirror: false }; }
    if (FIELD_TYPES[type]?.options) f.options = d.querySelector('#nf-opts').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (type === 'file') { f.accept = 'image/*'; f.maxMb = 10; }
    section.fields.push(f);
    S.sel = key;
    d.close();
    changed();
  });
  d.querySelector('#nf-label').focus();
}

function renderFieldEditor(box, loc) {
  const f = loc.field;
  const core = CORE_KEYS.has(f.key);
  const t = FIELD_TYPES[f.type] || {};
  const others = allFields(S.draft).map((x) => x.field).filter((x) => x.key !== f.key && x.type !== 'html' && x.type !== 'hidden');
  const hs = S.hubspot;
  const contactOpts = (sel) => `<option value="">— not sent to HubSpot —</option>${(hs?.contactProps || []).map((p) => `<option value="${esc(p.name)}"${p.name === sel ? ' selected' : ''}>${esc(p.label)} (${esc(p.name)})</option>`).join('')}${sel && !(hs?.contactProps || []).some((p) => p.name === sel) ? `<option selected value="${esc(sel)}">${esc(sel)}</option>` : ''}`;
  const dealOpts = (sel) => `<option value="">— not sent to HubSpot —</option>${(hs?.dealProps || []).map((p) => `<option value="${esc(p.name)}"${p.name === sel ? ' selected' : ''}>${esc(p.label)} (${esc(p.name)})</option>`).join('')}${sel && !(hs?.dealProps || []).some((p) => p.name === sel) ? `<option selected value="${esc(sel)}">${esc(sel)}</option>` : ''}`;
  const inJotform = f.qid && Number(f.qid) < 1000 || f.jf?.mirror === true;
  const sections = loc.step.sections;

  box.innerHTML = `<div class="insp-head"><button class="btn btn--sm" id="back">← All fields</button><h2>${esc(t.label || f.type)}</h2></div>
  <div class="insp-body">
    ${core ? '<div class="lint lint--warn">This field drives the flow, HubSpot and the portals — you can reword it, but not remove it or change its type.</div>' : ''}
    ${f.type === 'html' ? `
      <div class="field"><label for="fe-html">Text <span class="help">(basic HTML: &lt;p&gt;, &lt;strong&gt;, &lt;a href&gt;, lists)</span></label><textarea id="fe-html" rows="6">${esc(f.html || '')}</textarea></div>` : `
      <div class="field"><label for="fe-label">Label</label><input type="text" id="fe-label" value="${esc(f.label || '')}"></div>
      ${f.type !== 'hidden' ? `<div class="field"><label for="fe-help">Help text <span class="help">(optional)</span></label><input type="text" id="fe-help" value="${esc(f.help || '')}"></div>` : ''}
      ${['text', 'textarea', 'email', 'number'].includes(f.type) ? `<div class="field"><label for="fe-ph">Placeholder</label><input type="text" id="fe-ph" value="${esc(f.placeholder || '')}"></div>` : ''}
      ${!core && f.type !== 'hidden' ? `<div class="field"><label for="fe-type">Type</label><select id="fe-type">${Object.entries(FIELD_TYPES).filter(([k]) => !['hidden', 'html'].includes(k)).map(([k, v]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>` : ''}
      ${t.options ? `
        <div class="field"><label for="fe-src">Choices come from</label><select id="fe-src">
          <option value="">This list</option><option value="programs"${f.optionsFrom === 'programs' ? ' selected' : ''}>Programs (Programs &amp; dates tab)</option>
          <option value="terms"${f.optionsFrom === 'terms' ? ' selected' : ''}>Travel dates for the chosen program</option><option value="countries"${f.optionsFrom === 'countries' ? ' selected' : ''}>Countries</option></select></div>
        ${!f.optionsFrom ? `<div class="field"><label for="fe-opts">Choices <span class="help">(one per line)</span></label><textarea id="fe-opts" rows="6">${esc((f.options || []).join('\n'))}</textarea><span class="help">Renaming a choice that conditions or HubSpot rely on? Update them too.</span></div>` : ''}` : ''}
      ${f.type === 'file' ? `<label class="check"><input type="checkbox" id="fe-img"${f.accept === 'image/*' ? ' checked' : ''}> Photos only</label><div class="field"><label for="fe-max">Max size (MB)</label><input type="number" id="fe-max" min="1" max="25" value="${esc(f.maxMb || 10)}"></div>` : ''}
      ${f.type !== 'hidden' ? `
        <label class="check"><input type="checkbox" id="fe-req"${f.required ? ' checked' : ''}${core ? ' disabled' : ''}> Required</label>
        <label class="check"><input type="checkbox" id="fe-half"${f.width === 'half' ? ' checked' : ''}> Half width (sits beside the next half-width field)</label>
        <label class="check"><input type="checkbox" id="fe-sens"${f.sensitive ? ' checked' : ''}> Private (health / passport) — never shown back to the applicant</label>` : `<div class="kv">Filled automatically: <code>${esc(f.source || '')}</code></div>`}`}
    ${!core ? `<label class="check"><input type="checkbox" id="fe-hidden"${f.hidden ? ' checked' : ''}><span>Hide from applicants <span class="help">— keeps the field and its past answers</span></span></label>` : ''}

    ${f.type !== 'hidden' ? `
    <div class="field" style="margin-top:10px"><span class="lbl">Only show this field when…</span>
      <div id="rules">${(f.showIf?.rules || []).map((r, i) => ruleRow(r, i, others)).join('')}</div>
      ${f.showIf?.rules?.length > 1 ? `<select id="fe-match" class="inp" style="margin-bottom:6px"><option value="any"${f.showIf.match !== 'all' ? ' selected' : ''}>…any of these are true</option><option value="all"${f.showIf.match === 'all' ? ' selected' : ''}>…all of these are true</option></select>` : ''}
      <div><button class="btn btn--sm" id="add-rule">+ Add condition</button></div>
      ${!f.showIf?.rules?.length ? '<span class="help">Always shown.</span>' : ''}
    </div>` : ''}

    ${f.type !== 'html' ? `<details class="adv"${f.hubspot ? ' open' : ''}><summary>HubSpot</summary>
      ${!hs ? '<div class="help" style="margin-bottom:8px">Loading HubSpot properties…</div>' : hs.warning ? `<div class="help">${esc(hs.warning)}</div>` : ''}
      ${f.type === 'fullname' ? `<div class="row2"><div class="field"><label>First name → contact</label><select id="hs-first" class="inp">${contactOpts(f.hubspot?.contact?.first)}</select></div><div class="field"><label>Last name → contact</label><select id="hs-last" class="inp">${contactOpts(f.hubspot?.contact?.last)}</select></div></div>` : `
        <div class="field"><label for="hs-c">Contact property</label><select id="hs-c" class="inp">${contactOpts(typeof f.hubspot?.contact === 'string' ? f.hubspot.contact : '')}</select></div>
        <div class="field"><label for="hs-d">Deal property</label><select id="hs-d" class="inp">${dealOpts(f.hubspot?.deal || '')}</select></div>`}
      <span class="help">Written when the applicant finishes the step. A property HubSpot rejects is skipped (and logged on the application) rather than blocking it.</span>
    </details>` : ''}

    ${f.type !== 'html' ? `<details class="adv"><summary>Portals &amp; Jotform</summary>
      <div class="kv">Field key <code>${esc(f.key)}</code> · Field ID <code>${esc(f.qid || '—')}</code>${f.jf?.name ? ` · Jotform name <code>${esc(f.jf.name)}</code>` : ''}</div>
      <div class="kv">The portals read answers by this field ID, so keep it when rewording. ${inJotform ? 'This question exists in the Jotform form, so answers are mirrored there while the mirror is on.' : 'This field is new — it lives in pd-apply only.'}</div>
      <label class="check"><input type="checkbox" data-form="step1"${(f.jf?.forms || [loc.step.key]).includes('step1') ? ' checked' : ''}> Include in the Step 1 record</label>
      <label class="check"><input type="checkbox" data-form="step2"${(f.jf?.forms || [loc.step.key]).includes('step2') ? ' checked' : ''}> Include in the full application record (what the portals show)</label>
      ${!inJotform && f.qid ? '<button class="btn btn--sm" id="jf-add">Also create it in the Jotform form</button>' : ''}
    </details>` : ''}

    <div class="acts">
      <select id="fe-move" class="inp" style="width:auto">${sections.map((s) => `<option value="${esc(s.key)}"${s === loc.section ? ' selected' : ''}>Section: ${esc(s.title || s.key)}</option>`).join('')}</select>
      ${!core ? '<button class="btn btn--sm" id="fe-dup">Duplicate</button><button class="btn btn--sm btn--danger" id="fe-del">Delete</button>' : ''}
    </div>
  </div>`;

  const on = (sel, ev, fn) => { const el = $(sel, box); if (el) el.addEventListener(ev, fn); };
  const setv = (k, v, re = true) => { if (v === '' || v === false || v == null) delete f[k]; else f[k] = v; changed({ rerender: re }); };
  on('#back', 'click', () => { S.sel = null; renderInspector(); preview?.highlight(null); });
  on('#fe-label', 'input', (e) => { f.label = e.target.value; changed({ rerender: false }); refreshPreview(); });
  on('#fe-help', 'input', (e) => { setv('help', e.target.value, false); refreshPreview(); });
  on('#fe-ph', 'input', (e) => { setv('placeholder', e.target.value, false); refreshPreview(); });
  on('#fe-html', 'input', (e) => { f.html = e.target.value; changed({ rerender: false }); refreshPreview(); });
  on('#fe-type', 'change', (e) => {
    f.type = e.target.value;
    if (f.jf) f.jf.type = FIELD_TYPES[f.type].jf;
    if (FIELD_TYPES[f.type].options && !f.options?.length && !f.optionsFrom) f.options = ['Yes', 'No'];
    if (!FIELD_TYPES[f.type].options) { delete f.options; delete f.optionsFrom; }
    changed();
  });
  on('#fe-src', 'change', (e) => { if (e.target.value) { f.optionsFrom = e.target.value; } else { delete f.optionsFrom; f.options = f.options?.length ? f.options : ['Yes', 'No']; } changed(); });
  on('#fe-opts', 'input', (e) => { f.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); changed({ rerender: false }); refreshPreview(); });
  on('#fe-img', 'change', (e) => setv('accept', e.target.checked ? 'image/*' : ''));
  on('#fe-max', 'input', (e) => setv('maxMb', Math.max(1, Math.min(25, Number(e.target.value) || 10)), false));
  on('#fe-req', 'change', (e) => setv('required', e.target.checked));
  on('#fe-half', 'change', (e) => setv('width', e.target.checked ? 'half' : ''));
  on('#fe-sens', 'change', (e) => setv('sensitive', e.target.checked, false));
  on('#fe-hidden', 'change', (e) => setv('hidden', e.target.checked));
  on('#fe-match', 'change', (e) => { f.showIf.match = e.target.value; changed(); });
  on('#add-rule', 'click', () => {
    f.showIf = f.showIf || { match: 'any', rules: [] };
    const first = others.find((o) => FIELD_TYPES[o.type]?.options) || others[0];
    f.showIf.rules.push({ field: first?.key || '', op: 'equals', value: first ? (optionsFor(S.draft, first, {})[0] || '') : '' });
    changed();
  });
  $$('[data-rule]', box).forEach((row) => {
    const i = Number(row.dataset.rule);
    const r = f.showIf.rules[i];
    row.querySelector('[data-r=field]').addEventListener('change', (e) => { r.field = e.target.value; const dep = fieldByKey(S.draft, r.field); r.value = dep ? (optionsFor(S.draft, dep, {})[0] || '') : ''; changed(); });
    row.querySelector('[data-r=op]').addEventListener('change', (e) => { r.op = e.target.value; changed(); });
    const val = row.querySelector('[data-r=value]');
    val?.addEventListener(val.tagName === 'SELECT' ? 'change' : 'input', (e) => { r.value = e.target.value; changed({ rerender: val.tagName === 'SELECT' }); });
    row.querySelector('[data-r=del]').addEventListener('click', () => { f.showIf.rules.splice(i, 1); if (!f.showIf.rules.length) delete f.showIf; changed(); });
  });
  const hsSet = (target, v) => {
    f.hubspot = f.hubspot || {};
    if (v) f.hubspot[target] = v; else delete f.hubspot[target];
    if (!Object.keys(f.hubspot).length) delete f.hubspot;
    changed({ rerender: false });
  };
  on('#hs-c', 'change', (e) => hsSet('contact', e.target.value));
  on('#hs-d', 'change', (e) => hsSet('deal', e.target.value));
  const nameMap = () => {
    const first = $('#hs-first', box).value; const last = $('#hs-last', box).value;
    hsSet('contact', first || last ? { ...(first ? { first } : {}), ...(last ? { last } : {}) } : '');
  };
  on('#hs-first', 'change', nameMap); on('#hs-last', 'change', nameMap);
  $$('[data-form]', box).forEach((cb) => cb.addEventListener('change', () => {
    f.jf = f.jf || { name: f.key, type: FIELD_TYPES[f.type]?.jf, forms: [] };
    const forms = new Set(f.jf.forms || []);
    if (cb.checked) forms.add(cb.dataset.form); else forms.delete(cb.dataset.form);
    f.jf.forms = [...forms];
    changed({ rerender: false });
  }));
  on('#jf-add', 'click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const out = await api('POST', {}, { action: 'jotform-add', step: (f.jf?.forms || [loc.step.key]).includes('step2') ? 'step2' : 'step1', field: f });
      f.qid = out.qid; f.jf = { ...(f.jf || {}), name: out.name, type: out.type, mirror: true };
      changed(); toast(`Created in Jotform as question #${esc(out.qid)}.`);
    } catch (err) { btn.disabled = false; btn.textContent = 'Also create it in the Jotform form'; toast(esc(err.message), 6000); }
  });
  on('#fe-move', 'change', (e) => {
    const target = sections.find((s) => s.key === e.target.value);
    loc.section.fields.splice(loc.index, 1); target.fields.push(f); changed();
  });
  on('#fe-dup', 'click', () => {
    const copy = clone(f);
    copy.key = uniqueKey(`${f.key}Copy`);
    copy.label = `${f.label} (copy)`;
    if (copy.qid) { copy.qid = nextQid(S.draft); copy.jf = { ...(copy.jf || {}), name: copy.key, mirror: false }; }
    loc.section.fields.splice(loc.index + 1, 0, copy);
    S.sel = copy.key; changed();
  });
  on('#fe-del', 'click', async () => {
    const deps = allFields(S.draft).filter((x) => (x.field.showIf?.rules || []).some((r) => r.field === f.key));
    const extra = deps.length ? ` ${deps.length} other field${deps.length > 1 ? 's depend' : ' depends'} on it and will always show.` : '';
    if (!(await confirmDialog('Delete this field?', `Past answers stay on existing applications, but new applicants won't see it.${extra} Tip: "Hide from applicants" keeps it instead.`, 'Delete field'))) return;
    for (const d of deps) { d.field.showIf.rules = d.field.showIf.rules.filter((r) => r.field !== f.key); if (!d.field.showIf.rules.length) delete d.field.showIf; }
    loc.section.fields.splice(loc.index, 1);
    S.sel = null; changed();
  });
}

function ruleRow(r, i, others) {
  const dep = fieldByKey(S.draft, r.field);
  const opts = dep ? optionsFor(S.draft, dep, {}) : [];
  const needsValue = !['isFilled', 'isEmpty'].includes(r.op);
  const valueCtl = !needsValue ? '<span></span>'
    : opts.length ? `<select data-r="value" class="inp">${opts.map((o) => `<option${o === r.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}${r.value && !opts.includes(r.value) ? `<option selected>${esc(r.value)}</option>` : ''}</select>`
      : `<input data-r="value" class="inp" value="${esc(r.value || '')}">`;
  return `<div class="rule" data-rule="${i}">
    <select data-r="field" class="inp" aria-label="Field">${others.map((o) => `<option value="${esc(o.key)}"${o.key === r.field ? ' selected' : ''}>${esc((o.label || o.key).slice(0, 50))}</option>`).join('')}</select>
    <select data-r="op" class="inp" aria-label="Condition">${Object.entries(OPS).map(([k, v]) => `<option value="${k}"${k === r.op ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    ${valueCtl}
    <button class="btn btn--icon btn--sm" data-r="del" aria-label="Remove condition">×</button></div>`;
}

let pvTimer = null;
function refreshPreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(() => {
    const pv = $('#pv'); if (!pv) return;
    const y = pv.closest('.canvas').scrollTop;
    preview = renderStep(pv, S.draft, S.step, { preview: true, values: {}, onPick: (k) => { S.sel = k; renderInspector(); preview.highlight(k); } });
    if (S.sel) preview.highlight(S.sel);
    pv.closest('.canvas').scrollTop = y;
  }, 250);
}

// ── tab: programs & dates ───────────────────────────────────────────────────
function renderPrograms() {
  const d = S.draft;
  const pd = S.hubspot?.pdPrograms || [];
  const pdCell = (p, i) => pd.length
    ? `<select data-p="${i}" data-k="pdProgram"><option value="">— pick —</option>${pd.map((o) => `<option value="${esc(o.value)}"${o.value === p.pdProgram ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}${p.pdProgram && !pd.some((o) => o.value === p.pdProgram) ? `<option selected value="${esc(p.pdProgram)}">${esc(p.pdProgram)} (not in HubSpot)</option>` : ''}</select>`
    : `<input data-p="${i}" data-k="pdProgram" value="${esc(p.pdProgram || '')}" placeholder="HubSpot PD Program value">`;
  $('#app').innerHTML = `<div class="page">
    <div class="panel"><h2 class="serif">Programs</h2>
      <p class="sub">What applicants can choose. <strong>Type</strong> decides which travel dates are offered and which HubSpot pipeline the deal moves into when the fee is paid (Summer → Summer Program; Semester/Mini → Fall or Spring Semester / Mini Semester). <strong>Price</strong> becomes the deal amount. <strong>PD Program</strong> is the HubSpot value set on the deal.</p>
      <div style="overflow-x:auto"><table class="grid"><thead><tr><th>Program name (as applicants see it)</th><th>Type</th><th>Price (USD)</th><th>HubSpot PD Program</th><th>Offered</th><th></th></tr></thead><tbody>
      ${d.programs.map((p, i) => `<tr class="${p.active === false ? 'inactive' : ''}">
        <td><input data-p="${i}" data-k="name" value="${esc(p.name)}" aria-label="Program name"></td>
        <td><select data-p="${i}" data-k="type" aria-label="Type"><option value="semester"${p.type === 'semester' ? ' selected' : ''}>Gap semester</option><option value="mini"${p.type === 'mini' ? ' selected' : ''}>Mini semester</option><option value="summer"${p.type === 'summer' ? ' selected' : ''}>Summer</option></select></td>
        <td class="num"><input data-p="${i}" data-k="price" type="number" min="0" step="50" value="${esc(p.price ?? '')}" aria-label="Price"></td>
        <td>${pdCell(p, i)}</td>
        <td><input type="checkbox" data-p="${i}" data-k="active"${p.active !== false ? ' checked' : ''} aria-label="Offered" style="width:auto;min-height:0"></td>
        <td><button class="btn btn--icon btn--sm" data-pup="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="acts"><button class="btn btn--sm" id="add-prog">+ Add program</button>${pd.length ? '' : '<span class="em">HubSpot PD Program options load when HUBSPOT_TOKEN is set.</span>'}
      ${pd.length ? '<button class="btn btn--sm" id="auto-pd">Fill blank PD Programs automatically</button>' : ''}</div>
      <p class="em">Renaming a program changes what new applicants pick; existing applications keep the name they chose. Untick “Offered” instead of deleting a program.</p>
    </div>
    <div class="panel"><h2 class="serif">Travel dates</h2>
      <p class="sub">The “When are you traveling?” choices. Summer dates are offered for summer programs; Fall and Spring for semesters and mini semesters. The year becomes the deal’s <code>travel_year</code>.</p>
      <table class="grid" style="max-width:640px"><thead><tr><th>Label</th><th>Season</th><th>Year</th><th>Offered</th></tr></thead><tbody>
      ${d.terms.map((t, i) => `<tr class="${t.active === false ? 'inactive' : ''}"><td><input data-t="${i}" data-k="label" value="${esc(t.label)}" aria-label="Label"></td>
        <td><select data-t="${i}" data-k="season">${['Spring', 'Summer', 'Fall'].map((s) => `<option${s === t.season ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
        <td class="num"><input data-t="${i}" data-k="year" type="number" min="2024" max="2040" value="${esc(t.year)}"></td>
        <td><input type="checkbox" data-t="${i}" data-k="active"${t.active !== false ? ' checked' : ''} style="width:auto;min-height:0" aria-label="Offered"></td></tr>`).join('')}
      </tbody></table>
      <div class="acts"><button class="btn btn--sm" id="add-term">+ Add travel date</button></div>
    </div></div>`;
  $$('[data-p]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const p = d.programs[Number(el.dataset.p)];
    const k = el.dataset.k;
    if (k === 'active') p.active = el.checked;
    else if (k === 'price') p.price = el.value === '' ? null : Number(el.value);
    else p[k] = el.value;
    changed({ rerender: el.type === 'checkbox' });
  }));
  $$('[data-pup]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.pup); const [x] = d.programs.splice(i, 1); d.programs.splice(i - 1, 0, x); changed(); }));
  $$('[data-t]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const t = d.terms[Number(el.dataset.t)];
    const k = el.dataset.k;
    if (k === 'active') t.active = el.checked; else if (k === 'year') t.year = Number(el.value); else t[k] = el.value;
    if (k === 'season' || k === 'year') t.label = `${t.season} ${t.year}`;
    changed({ rerender: k !== 'label' });
  }));
  $('#add-prog').addEventListener('click', () => { d.programs.push({ name: 'New program', type: 'semester', price: null, pdProgram: '', active: false }); changed(); });
  $('#add-term').addEventListener('click', () => {
    const last = d.terms[d.terms.length - 1] || { season: 'Fall', year: new Date().getFullYear() };
    const order = ['Spring', 'Summer', 'Fall'];
    const ni = (order.indexOf(last.season) + 1) % 3;
    const t = { season: order[ni], year: last.year + (ni === 0 ? 1 : 0), active: true };
    t.label = `${t.season} ${t.year}`;
    d.terms.push(t); changed();
  });
  $('#auto-pd')?.addEventListener('click', () => {
    let n = 0;
    for (const p of d.programs) if (!p.pdProgram) { const m = guessPd(pd, p.name); if (m) { p.pdProgram = m; n++; } }
    changed(); toast(n ? `Filled ${n} program${n > 1 ? 's' : ''} — check them.` : 'No confident matches — pick them by hand.');
  });
}

// Same idea as pd-apply's routing.matchPdProgram (kept simple here; the
// server re-matches at sync time anyway).
function guessPd(options, name) {
  const stop = new Set(['gap', 'program', 'programs', 'the', 'and', 'semester', 'year']);
  const toks = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t && !stop.has(t));
  const kind = (s) => (/summer|field/i.test(s) ? 'summer' : /mini/i.test(s) ? 'mini' : 'semester');
  const want = toks(name);
  let best = null;
  for (const o of options) {
    if (kind(o.label) !== kind(name)) continue;
    const have = toks(o.label);
    const common = want.filter((t) => have.includes(t)).length;
    const score = common / Math.max(want.length, have.length, 1);
    if (!best || score > best.score) best = { score, value: o.value };
  }
  return best && best.score >= 0.67 ? best.value : '';
}

// ── editable email (subject, message, on/off) ───────────────────────────────
// Stored at settings.emails[key]; empty fields fall back to DEFAULT_EMAILS.
function emailEditor(st, key, title) {
  const e = st.emails?.[key] || {};
  const d = DEFAULT_EMAILS[key];
  return `<details class="panel" style="padding:12px 14px;margin:10px 0 0" data-email="${key}">
    <summary><strong>${esc(title)}</strong> <span class="em">— ${esc(e.subject || d.subject)}${e.enabled === false ? ' · off' : ''}</span></summary>
    <label class="check" style="margin-top:10px"><input type="checkbox" data-em="enabled"${e.enabled !== false ? ' checked' : ''}><span>Send this one</span></label>
    <div class="field"><label>Subject</label><input type="text" data-em="subject" value="${esc(e.subject || '')}" placeholder="${esc(d.subject)}"></div>
    <div class="field"><label>Message</label><textarea data-em="body" rows="12" placeholder="${esc(d.body)}">${esc(e.body || '')}</textarea>
      <span class="help">Leave empty to use the default shown. Placeholders: ${(EMAIL_PLACEHOLDERS[key] || []).map((k) => `<code>{${k}}</code>`).join(' ')}. A link: <code>[Finish my application]({link})</code>.</span>
      <button class="btn btn--sm" type="button" data-em-default style="margin-top:6px">Start from the default</button></div>
  </details>`;
}

function wireEmailEditors(st) {
  $$('[data-email]').forEach((box) => {
    const key = box.dataset.email;
    const get = () => { st.emails = st.emails || {}; st.emails[key] = st.emails[key] || {}; return st.emails[key]; };
    box.querySelectorAll('[data-em]').forEach((el) => {
      const f = el.dataset.em;
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => { get()[f] = el.type === 'checkbox' ? el.checked : el.value; changed({ rerender: false }); });
    });
    box.querySelector('[data-em-default]').addEventListener('click', () => {
      const d = DEFAULT_EMAILS[key];
      const subj = box.querySelector('[data-em=subject]'); const body = box.querySelector('[data-em=body]');
      if (!subj.value) { subj.value = d.subject; get().subject = d.subject; }
      if (!body.value) { body.value = d.body; get().body = d.body; }
      changed({ rerender: false });
    });
  });
}

// ── tab: settings ───────────────────────────────────────────────────────────
function renderSettings() {
  const st = S.draft.settings;
  st.texts = st.texts || {};
  st.jotform = st.jotform || {};
  const fee = Number(st.appFee || 0);
  const rate = Number(st.cardFeeRate || 0);
  const total = Math.round((fee + Math.round(fee * rate * 100) / 100) * 100) / 100;
  const txt = (k, label, rows = 2) => `<div class="field"><label for="tx-${k}">${label}</label><textarea id="tx-${k}" data-text="${k}" rows="${rows}">${esc(st.texts[k] || '')}</textarea></div>`;
  $('#app').innerHTML = `<div class="page">
    <div class="panel"><h2 class="serif">Application fee</h2><p class="sub">Charged by card through Stripe at step 4. The card fee is shown as its own line.</p>
      <div class="cols">
        <div class="field"><label for="s-fee">Application fee (USD)</label><input type="number" id="s-fee" min="1" step="1" value="${esc(st.appFee)}"></div>
        <div class="field"><label for="s-rate">Card processing fee (%)</label><input type="number" id="s-rate" min="0" max="19" step="0.1" value="${esc(Math.round(rate * 1000) / 10)}"></div>
        <div class="field"><span class="lbl">Applicant pays</span><div style="font-size:22px;font-weight:700;color:var(--ink)" id="s-total">$${total.toFixed(2)}</div></div>
      </div>
      <div class="cols">
        <div class="field"><label for="s-ach">ACH bank debit fee (%)</label><input type="number" id="s-ach" min="0" max="19" step="0.1" value="${esc(Math.round(Number(st.achFeeRate || 0) * 1000) / 10)}"><span class="help">Used for deposits and tuition payments made by US bank debit. The card fee above applies to card payments.</span></div>
      </div>
      <div class="field"><label for="tx-feePolicy">Refund wording (payment screen and Stripe page)</label><textarea id="tx-feePolicy" data-text="feePolicy" rows="2" placeholder="${esc(DEFAULT_FEE_POLICY)}">${esc(st.texts.feePolicy || '')}</textarea><span class="help">Leave empty to use the wording shown. <code>{fee}</code> becomes the fee amount. A link to the Program Terms &amp; Conditions is added after it.</span></div>
    </div>
    <div class="panel"><h2 class="serif">Talk to an advisor (all family emails)</h2><p class="sub">Shown at the bottom of every email to students and parents, with a button to book a call.</p>
      <label class="check"><input type="checkbox" id="ad-on"${st.advisor?.enabled !== false ? ' checked' : ''}><span>Show it</span></label>
      <div class="cols">
        <div class="field"><label for="ad-url">Booking link</label><input type="url" id="ad-url" value="${esc(st.advisor?.url || '')}" placeholder="${esc(DEFAULT_ADVISOR_URL)}"></div>
        <div class="field"><label for="ad-label">Button text</label><input type="text" id="ad-label" value="${esc(st.advisor?.label || '')}" placeholder="Book a call with an advisor"></div>
      </div>
      <div class="field"><label for="ad-text">Line above the button</label><input type="text" id="ad-text" value="${esc(st.advisor?.text || '')}" placeholder="${esc(DEFAULT_ADVISOR_TEXT)}"><span class="help">Leave any field empty to use what's shown.</span></div></div>
    <div class="panel"><h2 class="serif">Email: application fee received</h2><p class="sub">Sent to the student and every parent/guardian on the application once the fee is paid, from admissions@, with the current Program Terms &amp; Conditions at the bottom. Admissions also gets a short “fee paid” alert.</p>
      <label class="check"><input type="checkbox" id="em-fc-on"${st.emails?.feeConfirmation?.enabled !== false ? ' checked' : ''}><span>Send this email</span></label>
      <div class="field"><label for="em-fc-subject">Subject</label><input type="text" id="em-fc-subject" value="${esc(st.emails?.feeConfirmation?.subject || '')}" placeholder="${esc(DEFAULT_EMAILS.feeConfirmation.subject)}"></div>
      <div class="field"><label for="em-fc-body">Message</label><textarea id="em-fc-body" rows="14" placeholder="${esc(DEFAULT_EMAILS.feeConfirmation.body)}">${esc(st.emails?.feeConfirmation?.body || '')}</textarea>
      <span class="help">Leave empty to use the default shown. Placeholders: ${EMAIL_PLACEHOLDERS.feeConfirmation.map((k) => `<code>{${k}}</code>`).join(' ')}. Formatting: <code>**bold**</code>, <code>- bullet</code>, blank line between paragraphs.</span>
      <button class="btn btn--sm" type="button" id="em-fc-default" style="margin-top:6px">Start from the default</button></div></div>
    <div class="panel"><h2 class="serif">Reminders: application fee not paid</h2><p class="sub">For applicants who finished the full application but haven't paid the fee. Sent to the student and every parent/guardian, from admissions@, ${FEE_REMINDER_DAYS.map((d) => `${d}`).join(', ').replace(/, (\d+)$/, ' and $1')} days after the application was completed. Each has a personal link back to their application. Reminders stop as soon as the fee is paid or the application is withdrawn, and admissions can stop them for one applicant from the Applications tab. After ${FEE_CLOSE_DAYS} days an unpaid application is marked <em>Closed</em> (they can still pay).</p>
      <label class="check"><input type="checkbox" id="rm-on"${st.feeReminders?.enabled ? ' checked' : ''}><span>Send reminders <span class="help" id="rm-since">${st.feeReminders?.enabled && st.feeReminders?.since ? `— for applications completed since ${esc(new Date(st.feeReminders.since).toLocaleString())}` : '— only applications completed after you switch this on (and Publish) get them'}</span></span></label>
      ${[1, 2, 3, 4].map((n) => emailEditor(st, `feeReminder${n}`, `Reminder ${n} — day ${FEE_REMINDER_DAYS[n - 1]}`)).join('')}</div>
    <div class="panel"><h2 class="serif">Email: not accepted</h2><p class="sub">Sent to the student and parents when you click <em>Decline</em> on an application. <code>{message}</code> is the optional personal note you type when declining; <code>{refund}</code> is a line about the refunded application fee (empty when there's no refund).</p>
      ${emailEditor(st, 'declined', 'Not accepted')}</div>
    <div class="panel"><h2 class="serif">Acceptance &amp; deposit</h2><p class="sub">When you click <em>Accept</em>, the student and parents get a personal link to their acceptance page. There they choose how to pay (monthly, two instalments or in full — depending on how close the start date is) and pay the $2,250 deposit to confirm their place. The price comes from Programs &amp; dates; the start date from the program's HubSpot record.</p>
      <div class="field" style="max-width:260px"><label for="ac-hold">Hold a place for (days)</label><input type="number" id="ac-hold" min="1" max="60" value="${esc(st.acceptance?.holdDays ?? 7)}"><span class="help">The deposit is due by then. Admissions can extend one applicant's hold from the Applications tab.</span></div>
      ${(() => {
        const dc = st.discounts || (st.payInFull ? { enabled: st.payInFull.enabled, full: st.payInFull } : {});
        const cell = (plan, k) => `<td><input type="number" class="inp" data-disc="${plan}.${k}" min="0" step="50" value="${esc(dc[plan]?.[k] ?? '')}" placeholder="0" style="max-width:110px"></td>`;
        return `<div class="field" style="margin-top:14px"><label class="check"><input type="checkbox" id="pf-on"${dc.enabled ? ' checked' : ''}><span><strong>Payment plan discounts</strong></span></label>
        <table class="grid" style="max-width:520px;margin-top:6px"><thead><tr><th></th><th>Semester ($)</th><th>Mini semester ($)</th><th>Summer ($)</th></tr></thead><tbody>
          <tr><td>Pay in full</td>${['semester', 'mini', 'summer'].map((k) => cell('full', k)).join('')}</tr>
          <tr><td>Two instalments</td>${['semester', 'mini', 'summer'].map((k) => cell('two', k)).join('')}</tr>
        </tbody></table>
        <span class="help">Pay in full: taken off today's payment. Two instalments: taken off the final payment. Neither is offered within 60 days of the start date. Fixed when you click Accept, so changing them later doesn't affect families already accepted. Once the deposit is paid the HubSpot deal amount is reduced by the discount.</span></div>`;
      })()}
      ${emailEditor(st, 'accepted', 'Email: accepted')}
      ${emailEditor(st, 'enrolled', 'Email: place confirmed (deposit paid)')}
      <p class="help" style="margin-top:8px"><code>{howToPay}</code> adapts to the start date (monthly / two instalments / in full). <code>{message}</code> is the note you type when accepting. <code>{schedule}</code> is the list of upcoming payments.</p></div>
    <div class="panel"><h2 class="serif">Payments after the deposit</h2><p class="sub">Instalments are charged automatically to the card or bank account the family paid the deposit with (plus that method's fee above). They're emailed 3 days before each payment and get a receipt after. A payment that fails is tried again 3 and 7 days later; after the third failure admissions is emailed and it isn't tried again until you click <em>Retry</em>. Families on "balance later" get reminders 14 and 3 days before it's due, and admissions is told if it's overdue. Every email goes to the student and parents and is logged in HubSpot.</p>
      <label class="check"><input type="checkbox" id="pay-auto"${st.payments?.autoCharge !== false ? ' checked' : ''}><span>Charge instalments automatically <span class="help">— untick to stop all automatic charges (notices still go out)</span></span></label>
      <label class="check"><input type="checkbox" id="pay-dep"${st.payments?.depositReminders !== false ? ' checked' : ''}><span>Remind accepted applicants who haven't paid the deposit <span class="help">(5, 2 and 1 days before the hold ends; admissions is told when it passes)</span></span></label>
      ${emailEditor(st, 'depositReminder', 'Email: deposit reminder')}
      ${emailEditor(st, 'paymentUpcoming', 'Email: payment in 3 days')}
      ${emailEditor(st, 'paymentReceived', 'Email: payment received')}
      ${emailEditor(st, 'paymentFailed', 'Email: payment didn\'t go through')}
      ${emailEditor(st, 'balanceReminder', 'Email: balance due (balance later)')}</div>
    <div class="panel"><h2 class="serif">Interview</h2><p class="sub">Step 3 embeds this HubSpot scheduling page, prefilled with the applicant's name and email. Booking a time moves them on to payment automatically.</p>
      <div class="field"><label for="s-meet">HubSpot meetings link</label><input type="url" id="s-meet" value="${esc(st.meetingUrl || '')}" placeholder="https://meetings.hubspot.com/…"></div>
      <label class="check"><input type="checkbox" id="s-fb"${st.interviewFallback !== false ? ' checked' : ''}><span>Offer <em>"Can't find a time, or the calendar won't load?"</em> — they continue to payment, and admissions gets an email + HubSpot note to arrange the interview <span class="help">(recommended)</span></span></label>
      <div class="field" style="max-width:260px"><label for="s-fbdelay">Show that option after (seconds)</label><input type="number" id="s-fbdelay" min="0" max="600" value="${esc(st.interviewFallbackDelaySec ?? 30)}"><span class="help">It shows straight away if the calendar fails to load.</span></div>
      <label class="check"><input type="checkbox" id="s-skip"${st.allowSkipInterview ? ' checked' : ''}><span>Let applicants skip booking with no follow-up <span class="help">(not recommended — nobody is alerted)</span></span></label></div>
    <div class="panel"><h2 class="serif">Wording</h2><p class="sub">Headings and short messages on each screen.</p>
      <div class="cols"><div>${txt('welcomeTitle', 'Step 1 heading', 1)}${txt('welcomeBody', 'Step 1 intro', 3)}${txt('interviewTitle', 'Interview heading', 1)}${txt('interviewBody', 'Interview intro', 3)}</div>
      <div>${txt('paymentTitle', 'Payment heading', 1)}${txt('paymentBody', 'Payment intro', 3)}${txt('doneTitle', 'Finished heading', 1)}${txt('doneBody', 'Finished message', 3)}</div></div></div>
    <div class="panel"><h2 class="serif">HubSpot source tracking</h2><p class="sub">Step 1 is submitted to this HubSpot form with the visitor's HubSpot cookie <em>before</em> anything else, so the contact's Original Source in HubSpot is the real channel instead of "Offline Sources". The source details (UTMs, ad click, landing page, referring site) are also written to the contact's <code>pd_first_*</code> / <code>pd_last_*</code> properties — see the Lead Sources dashboard.</p>
      <div class="field" style="max-width:520px"><label for="s-hsform">HubSpot form ID</label><div style="display:flex;gap:8px"><input type="text" id="s-hsform" value="${esc(st.hubspotFormGuid || '')}" placeholder="e.g. 1a2b3c4d-5e6f-…"><button class="btn btn--sm" type="button" id="s-hsform-new">Create in HubSpot</button></div>
      <span class="help">Leave empty to skip the form (the contact is still created, but HubSpot will call it Offline). Turn off HubSpot's own notification emails for this form — admissions already gets one.</span></div></div>
    <div class="panel"><h2 class="serif">Jotform mirror</h2><p class="sub">While pd-apply's <code>JOTFORM_MIRROR</code> is on, each step is also saved into these Jotform forms (same field IDs) so anything still reading Jotform keeps working. Once the portals read pd-apply directly you can turn the mirror off and archive both forms.</p>
      <div class="cols"><div class="field"><label for="s-jf1">Step 1 form ID</label><input type="text" id="s-jf1" value="${esc(st.jotform.step1 || '')}"></div>
      <div class="field"><label for="s-jf2">Full application form ID</label><input type="text" id="s-jf2" value="${esc(st.jotform.step2 || '')}"></div></div></div>
  </div>`;
  const recalc = () => { const f = Number(st.appFee) || 0; const r = Number(st.cardFeeRate) || 0; $('#s-total').textContent = `$${(f + Math.round(f * r * 100) / 100).toFixed(2)}`; };
  $('#s-fee').addEventListener('input', (e) => { st.appFee = Number(e.target.value); recalc(); changed({ rerender: false }); });
  $('#s-rate').addEventListener('input', (e) => { st.cardFeeRate = Math.round(Number(e.target.value) * 10) / 1000; recalc(); changed({ rerender: false }); });
  $('#s-ach').addEventListener('input', (e) => { st.achFeeRate = Math.round(Number(e.target.value) * 10) / 1000; changed({ rerender: false }); });
  const fc = () => { st.emails = st.emails || {}; st.emails.feeConfirmation = st.emails.feeConfirmation || {}; return st.emails.feeConfirmation; };
  $('#em-fc-on').addEventListener('change', (e) => { fc().enabled = e.target.checked; changed({ rerender: false }); });
  $('#em-fc-subject').addEventListener('input', (e) => { fc().subject = e.target.value; changed({ rerender: false }); });
  $('#em-fc-body').addEventListener('input', (e) => { fc().body = e.target.value; changed({ rerender: false }); });
  $('#em-fc-default').addEventListener('click', () => {
    if (!$('#em-fc-subject').value) { $('#em-fc-subject').value = DEFAULT_EMAILS.feeConfirmation.subject; fc().subject = DEFAULT_EMAILS.feeConfirmation.subject; }
    if (!$('#em-fc-body').value) { $('#em-fc-body').value = DEFAULT_EMAILS.feeConfirmation.body; fc().body = DEFAULT_EMAILS.feeConfirmation.body; }
    changed({ rerender: false });
  });
  wireEmailEditors(st);
  const ad = () => { st.advisor = st.advisor || {}; return st.advisor; };
  $('#ad-on').addEventListener('change', (e) => { ad().enabled = e.target.checked; changed({ rerender: false }); });
  [['#ad-url', 'url'], ['#ad-label', 'label'], ['#ad-text', 'text']].forEach(([sel, k]) => $(sel).addEventListener('input', (e) => { ad()[k] = e.target.value.trim(); changed({ rerender: false }); }));
  [['#pay-auto', 'autoCharge'], ['#pay-dep', 'depositReminders']].forEach(([sel, k]) => $(sel).addEventListener('change', (e) => { st.payments = { ...(st.payments || {}), [k]: e.target.checked }; changed({ rerender: false }); }));
  const disc = () => { st.discounts = st.discounts || (st.payInFull ? { enabled: !!st.payInFull.enabled, full: { ...st.payInFull } } : { enabled: false }); delete st.discounts.full?.enabled; delete st.payInFull; return st.discounts; };
  $('#pf-on').addEventListener('change', (e) => { disc().enabled = e.target.checked; changed({ rerender: false }); });
  $$('[data-disc]').forEach((el) => el.addEventListener('input', () => {
    const [plan, k] = el.dataset.disc.split('.');
    const n = Math.max(0, Math.round(Number(el.value) * 100) / 100);
    const d = disc(); d[plan] = { ...(d[plan] || {}), [k]: Number.isFinite(n) ? n : 0 };
    changed({ rerender: false });
  }));
  $('#ac-hold').addEventListener('input', (e) => { const n = Math.round(Number(e.target.value)); st.acceptance = { ...(st.acceptance || {}) }; if (n >= 1 && n <= 60) st.acceptance.holdDays = n; else delete st.acceptance.holdDays; changed({ rerender: false }); });
  $('#rm-on').addEventListener('change', (e) => {
    st.feeReminders = st.feeReminders || {};
    st.feeReminders.enabled = e.target.checked;
    // The start line: only applications completed after this get reminders,
    // so switching on never emails the backlog. Every switch-on starts afresh.
    if (e.target.checked) st.feeReminders.since = new Date().toISOString();
    $('#rm-since').textContent = e.target.checked ? `— for applications completed from now on. Publish to start.` : '— off';
    changed({ rerender: false });
  });
  $('#s-meet').addEventListener('input', (e) => { st.meetingUrl = e.target.value.trim(); changed({ rerender: false }); });
  $('#s-skip').addEventListener('change', (e) => { st.allowSkipInterview = e.target.checked; changed({ rerender: false }); });
  $('#s-fb').addEventListener('change', (e) => { st.interviewFallback = e.target.checked; changed({ rerender: false }); });
  $('#s-fbdelay').addEventListener('input', (e) => { st.interviewFallbackDelaySec = Math.max(0, Math.min(600, Number(e.target.value) || 0)); changed({ rerender: false }); });
  $('#s-hsform').addEventListener('input', (e) => { st.hubspotFormGuid = e.target.value.trim(); changed({ rerender: false }); });
  $('#s-hsform-new').addEventListener('click', async (e) => {
    if (st.hubspotFormGuid && !(await confirmDialog('Create another HubSpot form?', 'A form ID is already set. Create a new form and use it instead?', 'Create', false))) return;
    e.target.disabled = true;
    try {
      const out = await api('POST', {}, { action: 'hubspot-form-create', form: 'application' });
      st.hubspotFormGuid = out.id; $('#s-hsform').value = out.id; changed({ rerender: false });
      toast(`Created “${esc(out.name)}” in HubSpot. Publish to start using it.`, 7000);
    } catch (err) { toast(esc(err.message), 9000); } finally { e.target.disabled = false; }
  });
  $('#s-jf1').addEventListener('input', (e) => { st.jotform.step1 = e.target.value.trim(); changed({ rerender: false }); });
  $('#s-jf2').addEventListener('input', (e) => { st.jotform.step2 = e.target.value.trim(); changed({ rerender: false }); });
  $$('[data-text]').forEach((el) => el.addEventListener('input', () => { st.texts[el.dataset.text] = el.value; changed({ rerender: false }); }));
}

// ── tab: terms ──────────────────────────────────────────────────────────────
// The Program Terms & Conditions: one document, its own Save / Publish (the
// header's Publish button is for the form). Each publish is a new version;
// pd-apply serves the latest to the website, the emails and the payment pages,
// and records which version each family was shown.
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '');

async function loadTerms() {
  const t = await api('GET', { action: 'terms' });
  S.terms = { ...t, dirty: false, saving: false, timer: null };
}

function termsChanged() {
  const T = S.terms;
  T.dirty = true;
  $('#t-state').textContent = 'Unsaved changes';
  $('#t-preview').innerHTML = termsToHtml(T.draft) || '<p class="help">Nothing to preview yet.</p>';
  clearTimeout(T.timer);
  T.timer = setTimeout(saveTerms, SAVE_DELAY);
  termsChrome();
}

async function saveTerms() {
  const T = S.terms;
  if (!T || T.saving || !T.dirty) return;
  T.saving = true; T.dirty = false;
  $('#t-state') && ($('#t-state').textContent = 'Saving…');
  try {
    await api('POST', {}, { action: 'terms-save', title: T.title, body: T.draft });
    T.updatedAt = new Date().toISOString();
    if ($('#t-state')) $('#t-state').textContent = `Draft saved ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    T.dirty = true;
    if ($('#t-state')) $('#t-state').textContent = `Not saved: ${err.message}`;
  } finally { T.saving = false; termsChrome(); }
}

function termsChrome() {
  const T = S.terms;
  if (!T || !$('#t-publish')) return;
  const same = T.live && T.live.body.trim() === T.draft.trim() && T.live.title === T.title;
  $('#t-publish').disabled = !S.user?.canPublish || same || T.draft.trim().length < 200;
  $('#t-publish').title = !S.user?.canPublish ? 'Publishing needs an admin or admissions lead.' : same ? 'The draft is the same as the live version.' : '';
  $('#t-diff').textContent = !T.live ? 'Not published yet — the website, emails and payment pages have no terms until you publish.' : same ? `Live: version ${T.live.version}, published ${fmtDate(T.live.publishedAt)}` : `Live: version ${T.live.version}. The draft has changes that aren't live yet.`;
}

async function renderTerms() {
  if (!S.terms) {
    $('#app').innerHTML = '<div class="loading">Loading terms…</div>';
    try { await loadTerms(); }
    catch (err) {
      $('#app').innerHTML = `<div class="page"><div class="notice notice--bad">${esc(err.message)}${/apply_terms/.test(err.message) ? ' — run <code>MIGRATION-terms.sql</code> in the Neon SQL editor first.' : ''}</div></div>`;
      return;
    }
    if (S.tab !== 'terms') return;
  }
  const T = S.terms;
  const site = (T.applySite || S.applySite || 'https://apply.pacificdiscovery.org').replace(/\/+$/, '');
  const snippet = `<div id="pd-terms"></div>\n<script src="${site}/terms-embed.js" defer></script>`;
  $('#app').innerHTML = `<div class="page">
    <div class="panel">
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
        <div><h2 class="serif">Program Terms &amp; Conditions</h2><p class="sub" id="t-diff" style="margin:4px 0 0"></p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn--sm" type="button" id="t-import">Import from website</button>
          <button class="btn btn--sm" type="button" id="t-versions">Versions (${T.versions.length})</button>
          <button class="btn btn--primary" type="button" id="t-publish">Publish terms</button>
        </div>
      </div>
      <p class="sub" style="margin-top:10px">Shown on the website terms page, in the application-fee email, on the Stripe payment page, and on the acceptance page. Publishing creates a new version; each payment records the version the family saw. <span id="t-state">${T.updatedAt ? `Draft saved ${fmtDate(T.updatedAt)}` : ''}</span></p>
      <div class="field" style="max-width:520px"><label for="t-title">Title</label><input type="text" id="t-title" value="${esc(T.title)}" maxlength="200"></div>
      <div class="cols" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start">
        <div class="field"><label for="t-body">Text</label><textarea id="t-body" rows="32" spellcheck="true" style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${esc(T.draft)}</textarea>
          <span class="help"><code># Heading</code> · <code>## Sub-heading</code> · <code>1. numbered</code> · <code>- bullet</code> · <code>**bold**</code> · <code>[link](https://…)</code> · blank line between paragraphs.</span></div>
        <div class="field"><span class="lbl">Preview</span><div id="t-preview" class="panel" style="max-height:760px;overflow:auto;margin:0;line-height:1.6"></div></div>
      </div>
    </div>
    <div class="panel"><h2 class="serif">On the website</h2><p class="sub">Paste this into the terms page on pacificdiscovery.org (an HTML / custom code block) once. After that, publishing here updates the page within a minute.</p>
      <textarea readonly rows="2" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px" onclick="this.select()">${esc(snippet)}</textarea>
      <p class="sub" style="margin:8px 0 0">Stand-alone page: <a href="${esc(site)}/terms" target="_blank" rel="noopener">${esc(site)}/terms</a></p></div>
  </div>`;
  $('#t-preview').innerHTML = termsToHtml(T.draft) || '<p class="help">Nothing to preview yet. Use “Import from website” to start from the current page.</p>';
  termsChrome();
  $('#t-title').addEventListener('input', (e) => { T.title = e.target.value; termsChanged(); });
  $('#t-body').addEventListener('input', (e) => { T.draft = e.target.value; termsChanged(); });
  $('#t-import').addEventListener('click', async (e) => {
    if (T.draft.trim() && !(await confirmDialog('Replace the draft?', 'This replaces the draft text with the current website page. The live version is not affected until you publish.', 'Replace draft', true))) return;
    e.target.disabled = true;
    try {
      const out = await api('POST', {}, { action: 'terms-import' });
      T.draft = out.body; $('#t-body').value = out.body; termsChanged();
      toast(`Imported ${out.chars.toLocaleString()} characters from the website. Check the headings and lists, then publish.`, 8000);
    } catch (err) { toast(esc(err.message), 9000); } finally { e.target.disabled = false; }
  });
  $('#t-publish').addEventListener('click', async () => {
    await saveTerms();
    const note = await promptDialog('Publish the terms?', 'A new version goes live on the website, emails and payment pages. Families who already paid keep the version they agreed to. Optional note (what changed):', 'e.g. Added payment plan section');
    if (note === null) return;
    try {
      const out = await api('POST', {}, { action: 'terms-publish', note });
      await loadTerms(); renderTerms();
      toast(`Version ${out.version} is live.`);
    } catch (err) { toast(esc(err.message), 8000); }
  });
  $('#t-versions').addEventListener('click', () => {
    const d = openDialog(`<div class="dlg-head"><h2 class="serif">Terms versions</h2><button class="btn btn--sm" data-x>Close</button></div>
      <div class="dlg-body">${T.versions.length ? T.versions.map((v) => `<div class="panel" style="padding:12px;margin-bottom:8px"><strong>Version ${v.version}</strong> · ${fmtDate(v.published_at)} · ${esc(v.published_by || '')}${v.note ? `<div class="em">${esc(v.note)}</div>` : ''}
        <div style="margin-top:6px;display:flex;gap:6px"><button class="btn btn--sm" data-view="${v.version}">View</button><button class="btn btn--sm" data-copy="${v.version}">Copy into draft</button></div></div>`).join('') : '<p>No versions yet — publish to create version 1.</p>'}</div>`);
    d.querySelector('[data-x]').onclick = () => d.close();
    d.querySelectorAll('[data-view],[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const v = await api('GET', { action: 'terms-version', v: b.dataset.view || b.dataset.copy });
        if (b.dataset.view) {
          d.querySelector('.dlg-body').innerHTML = `<p class="sub">Version ${v.version} · ${fmtDate(v.publishedAt)}</p><div class="panel">${termsToHtml(v.body)}</div>`;
          return;
        }
        d.close();
        T.draft = v.body; T.title = v.title; renderTerms(); termsChanged();
        toast(`Version ${v.version} copied into the draft. Publish to make it live again.`);
      } catch (err) { toast(esc(err.message)); }
    }));
  });
}

// ── tab: applications ───────────────────────────────────────────────────────
const STATUS_LABEL = { step1: 'Started', step2: 'Application in', interview: 'Interview booked', needs_interview: 'Interview needed', paid: 'Fee paid', accepted: 'Accepted', deposit_paid: 'Deposit paid', declined: 'Declined', closed: 'Closed (unpaid)', withdrawn: 'Withdrawn' };
const PLAN_LABEL = { monthly: 'Monthly', two: 'Two instalments', full: 'Paid in full', later: 'Balance later' };
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
const fmtDay = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
function decisionChip(r) {
  const d = r.decision;
  if (!d || r.status === 'withdrawn') return '';
  if (d.outcome === 'declined') return '<span class="chip chip--bad">Declined</span>';
  const dep = r.enrolment?.deposit;
  if (r.enrolment?.withdrawn) return '';
  if ((r.enrolment?.schedule || []).some((p) => p.status === 'needs_admissions')) return '<span class="chip chip--bad">Payment failed — contact family</span>';
  if ((r.enrolment?.schedule || []).some((p) => p.status === 'failed')) return '<span class="chip chip--changes">Payment failed — retrying</span>';
  if (dep?.status === 'paid') return `<span class="chip chip--live">Deposit paid · ${esc(PLAN_LABEL[r.enrolment.plan] || '')}${r.enrolment.paused ? ' · paused' : ''}</span>`;
  if (dep?.status === 'processing') return '<span class="chip chip--info">Deposit clearing (bank)</span>';
  if (d.holdUntil && new Date(d.holdUntil) < new Date()) return `<span class="chip chip--bad" title="Accepted — the hold passed without a deposit">Hold passed ${fmtDay(d.holdUntil)}</span>`;
  return `<span class="chip chip--live" title="Place held until ${esc(new Date(d.holdUntil).toLocaleString())}">Accepted · held to ${fmtDay(d.holdUntil)}</span>`;
}
function reminderChip(r) {
  const m = r.reminders || {};
  if (r.paidAt || r.status === 'withdrawn') return '';
  if (m.closedAt) return '<span class="chip chip--bad">Closed — unpaid</span>';
  if (m.stopped) return '<span class="chip">Reminders stopped</span>';
  if (m.count) return `<span class="chip chip--info" title="${esc(m.sent.map((x) => `Reminder ${x.stage}: ${new Date(x.at).toLocaleDateString()}`).join('\n'))}">Reminder ${m.sent[m.sent.length - 1].stage}/4 sent</span>`;
  return '';
}
const needsInterview = (r) => !!(r.interview?.fallback && !r.interviewAt && r.status !== 'withdrawn');

async function renderApps() {
  const a = S.apps;
  $('#app').innerHTML = `<div class="page"><div class="filters" id="flt"></div><div id="apps-body" class="loading">Loading applications…</div></div>`;
  try {
    const out = await api('GET', { action: 'applications', status: a.status, q: a.q });
    a.list = out.applications; a.counts = out.counts;
  } catch (err) { $('#apps-body').innerHTML = `<div class="notice notice--bad">${esc(err.message)}</div>`; return; }
  const total = Object.entries(a.counts).filter(([k]) => !['withdrawn', 'needs_interview', 'closed', 'accepted', 'declined', 'deposit_paid'].includes(k)).reduce((x, [, n]) => x + n, 0);
  $('#flt').innerHTML = `<button class="chipbtn" data-st="" aria-pressed="${!a.status}">All · ${total}</button>${Object.keys(STATUS_LABEL).map((k) => `<button class="chipbtn" data-st="${k}" aria-pressed="${a.status === k}">${STATUS_LABEL[k]} · ${a.counts[k] || 0}</button>`).join('')}
    <input class="inp" id="q" placeholder="Search name, email or program" value="${esc(a.q)}" style="max-width:280px;margin-left:auto">`;
  $$('[data-st]').forEach((b) => b.addEventListener('click', () => { a.status = b.dataset.st; renderApps(); }));
  let qt;
  $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { a.q = e.target.value; renderApps(); }, 400); });
  const body = $('#apps-body');
  body.classList.remove('loading');
  if (!a.list.length) { body.innerHTML = '<div class="panel">No applications yet.</div>'; return; }
  body.innerHTML = `<div style="overflow-x:auto"><table class="grid apps"><thead><tr><th>Applicant</th><th>Program</th><th>Progress</th><th>Started</th><th>Sync</th></tr></thead><tbody>
    ${a.list.map((r) => `<tr data-id="${r.id}" tabindex="0">
      <td><div class="nm">${esc(r.name)}</div><div class="em">${esc(r.email)}</div></td>
      <td>${esc(r.program || '')}<div class="em">${esc(r.term || '')}</div></td>
      <td><div class="dots" title="${esc(STATUS_LABEL[r.status])}"><span class="on"></span><span class="${r.step2At ? 'on' : ''}"></span><span class="${r.interviewAt ? 'on' : ''}"></span><span class="${r.paidAt ? 'paid' : ''}"></span></div><div class="em">${esc(STATUS_LABEL[r.status])}</div>${needsInterview(r) ? '<span class="chip chip--changes">Interview needed</span>' : ''}${reminderChip(r)}${decisionChip(r)}</td>
      <td class="em">${new Date(r.createdAt).toLocaleDateString()}</td>
      <td>${r.sync.ok ? '<span class="chip chip--live">OK</span>' : `<span class="chip chip--bad" title="${esc(r.sync.problems.join('\n'))}">Needs a look</span>`}</td></tr>`).join('')}
  </tbody></table></div>`;
  $$('.apps tr[data-id]').forEach((tr) => {
    const open = () => showApplication(tr.dataset.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function payStatus(p) {
  const tip = p.lastError ? ` title="${esc(`${p.lastError.reason}${p.lastError.message ? ` — ${p.lastError.message}` : ''}`)}"` : '';
  switch (p.status) {
    case 'paid': return `<span class="chip chip--live">paid ${p.paidAt ? new Date(p.paidAt).toLocaleDateString() : ''}</span>`;
    case 'scheduled': return `<span class="em">automatic${p.noticeAt ? ' · notice sent' : ''}</span>`;
    case 'due': return `<span class="em">family pays by this date${p.overdueAt ? ' — <strong>overdue</strong>' : ''}</span>`;
    case 'processing': case 'charging': return '<span class="chip chip--info">clearing</span>';
    case 'failed': return `<span class="chip chip--changes"${tip}>failed ×${p.attempts || 1} · retry ${p.nextAttemptAt ? new Date(p.nextAttemptAt).toLocaleDateString() : 'soon'}</span>`;
    case 'needs_admissions': return `<span class="chip chip--bad"${tip}>failed ×${p.attempts || 3} — contact the family</span>`;
    case 'cancelled': return '<span class="em">cancelled</span>';
    default: return esc(p.status);
  }
}

function decisionBlock(app) {
  if ((app.status === 'withdrawn' && !app.enrolment?.withdrawn) || !app.step2At) return '';
  const d = app.decision;
  const can = !!S.user?.canDecide;
  const lines = [];
  if (d) {
    const who = `${esc(d.by || '')}, ${new Date(d.at).toLocaleString()}`;
    if (d.outcome === 'accepted') lines.push(`<li>✅ <strong>Accepted</strong> — ${who}. ${['paid', 'processing'].includes(app.enrolment?.deposit?.status) ? '' : ` Place held until <strong>${new Date(d.holdUntil).toLocaleString()}</strong> for the ${money(app.enrolment?.offer?.deposit || d.offer?.deposit || 2250)} deposit${new Date(d.holdUntil) < new Date() ? ' — <strong>passed</strong>' : ''}.`}</li>`);
    else lines.push(`<li>❌ <strong>Declined</strong> — ${who}.</li>`);
    if (d.refund) lines.push(`<li>💳 Application fee refunded: $${(d.refund.amount / 100).toFixed(2)} <span class="em">(Stripe ${esc(d.refund.id)})</span></li>`);
    else if (d.outcome === 'declined') lines.push('<li class="em">Application fee not refunded.</li>');
    if (d.email?.to) lines.push(`<li>✉️ Emailed ${esc(d.email.to.join(', '))}${d.email.hubspot?.error ? ` <span class="em">· ⚠️ not logged in HubSpot: ${esc(d.email.hubspot.error)}</span>` : ''}</li>`);
    if (d.email?.error) lines.push(`<li>⚠️ Email not sent: ${esc(d.email.error)} — use <em>Send acceptance email</em> to try again.</li>`);
    if (d.outcome === 'accepted' && !d.email) lines.push(`<li>⚠️ <strong>No acceptance email has been sent.</strong>${d.offerError ? ` <span class="em">(${esc(d.offerError)})</span>` : ''} Use <em>Send acceptance email</em> below.</li>`);
    for (const x of d.resent || []) lines.push(`<li class="em">Acceptance email sent again ${new Date(x.at).toLocaleString()} by ${esc(x.by || '')}</li>`);
    if (d.hubspot?.ok === false) lines.push(`<li>⚠️ HubSpot not updated: ${esc(d.hubspot.error)}</li>`);
    else if (d.hubspot?.stage) lines.push(`<li class="em">Deal moved to ${esc(d.hubspot.pipeline || '')} / ${esc(d.hubspot.stage)}</li>`);
    if (d.message) lines.push(`<li class="em">Message: “${esc(d.message)}”</li>`);
    for (const x of d.extended || []) lines.push(`<li class="em">Hold extended to ${new Date(x.holdUntil).toLocaleDateString()} by ${esc(x.by || '')}</li>`);
  }
  const e = app.enrolment;
  if (d?.outcome === 'accepted' && e) {
    const dep = e.deposit;
    if (e.offer) lines.push(`<li class="em">Offer: tuition ${money(e.offer.tuition)}, starts ${esc(e.offer.start)}</li>`);
    if (dep?.status === 'paid' || dep?.status === 'processing') {
      lines.push(`<li>${dep.status === 'paid' ? '💳' : '⏳'} <strong>${dep.status === 'paid' ? 'Deposit paid' : 'Bank payment clearing'}</strong> — ${money(dep.total)} by ${dep.method === 'ach' ? 'bank account' : 'card'} on ${new Date(dep.paidAt).toLocaleDateString()} <span class="em">(${esc(dep.reference || '')})</span>. Plan: <strong>${esc(PLAN_LABEL[e.plan] || e.plan || '')}</strong>${dep.discount ? ` <span class="chip chip--info">−${money(dep.discount)} ${dep.discountPlan === 'two' ? 'two-instalment' : 'pay-in-full'} discount</span>` : ''}${e.termsVersion ? ` · terms v${esc(e.termsVersion)}` : ''}</li>`);
      const rest = (e.schedule || []).slice(1);
      if (rest.length) lines.push(`<li><table class="grid" style="margin:4px 0;font-size:13px"><tbody>${rest.map((p, k) => `<tr><td>${esc(p.due)}</td><td style="text-align:right">${money(p.amount)}</td><td>${payStatus(p)}</td><td style="white-space:nowrap">${p.status === 'needs_admissions' && can ? `<button class="btn btn--sm" data-retry="${k + 1}">Retry</button> ` : ''}${['scheduled', 'failed', 'needs_admissions', 'due'].includes(p.status) && can && !e.withdrawn ? `<button class="btn btn--sm" data-markpaid="${k + 1}" title="Paid another way (e.g. bank transfer) — it won't be charged">Mark paid</button>` : ''}</td></tr>`).join('')}</tbody></table></li>`);
      if (e.paused) lines.push(`<li>⏸️ Automatic payments paused ${new Date(e.paused.at).toLocaleDateString()} by ${esc(e.paused.by || '')}</li>`);
      if (e.withdrawn) lines.push(`<li>🚫 <strong>Withdrew</strong> ${new Date(e.withdrawn.at).toLocaleDateString()} (${esc(e.withdrawn.by || '')})${e.withdrawn.reason ? ` — ${esc(e.withdrawn.reason)}` : ''}. Kept ${money(e.withdrawn.kept)}; upcoming payments cancelled.</li>`);
      if (e.emails?.enrolled?.to) lines.push(`<li>✉️ Confirmation emailed ${esc(e.emails.enrolled.to.join(', '))}${e.emails.enrolled.hubspot?.error ? ` <span class="em">· ⚠️ not logged in HubSpot: ${esc(e.emails.enrolled.hubspot.error)}</span>` : ''}</li>`);
      if (e.emails?.enrolled?.error) lines.push(`<li>⚠️ Confirmation email not sent: ${esc(e.emails.enrolled.error)}</li>`);
      if (e.hubspot?.ok === false) lines.push(`<li>⚠️ HubSpot not updated for the deposit: ${esc(e.hubspot.error)}</li>`);
    } else if (e.holdExpired && !dep) {
      lines.push(`<li>⚠️ Hold passed ${new Date(e.holdExpired.at).toLocaleDateString()} without a deposit.</li>`);
    } else if (dep?.status === 'failed') {
      lines.push(`<li>⚠️ Bank payment for the deposit failed ${new Date(dep.failedAt).toLocaleDateString()} — they can pay again from their acceptance link.</li>`);
    } else if (e.started) {
      lines.push(`<li class="em">Opened checkout ${new Date(e.started.at).toLocaleString()} (${esc(PLAN_LABEL[e.started.plan] || '')}, ${e.started.method === 'ach' ? 'bank' : 'card'}) — not paid yet.</li>`);
    }
  }
  const btns = [];
  if (!d || d.outcome !== 'declined') {
    if (!d) btns.push(`<button class="btn btn--sm btn--primary" id="dec-accept"${!can ? ' disabled title="Needs the admin or admissions role"' : ''}>Accept</button>`);
    const depositIn = ['paid', 'processing'].includes(app.enrolment?.deposit?.status);
    if (depositIn && !app.enrolment?.withdrawn && (app.enrolment?.schedule || []).some((p) => ['scheduled', 'failed'].includes(p.status))) btns.push(`<button class="btn btn--sm" id="pay-pause" data-paused="${app.enrolment.paused ? 1 : 0}"${!can ? ' disabled' : ''}>${app.enrolment.paused ? 'Resume automatic payments' : 'Pause automatic payments'}</button>`);
    if (d?.outcome === 'accepted' && !depositIn) btns.push(`<button class="btn btn--sm${d.email?.to ? '' : ' btn--primary'}" id="dec-resend"${!can ? ' disabled' : ''}>${d.email?.to ? 'Resend acceptance email' : 'Send acceptance email'}</button>`);
    if (d?.outcome === 'accepted' && !depositIn) btns.push(`<button class="btn btn--sm" id="dec-extend"${!can ? ' disabled title="Needs the admin or admissions role"' : ''}>Extend hold</button>`);
    if (!depositIn) btns.push(`<button class="btn btn--sm btn--danger" id="dec-decline"${!can ? ' disabled title="Needs the admin or admissions role"' : ''}>Decline</button>`);
  }
  return `<div class="panel" style="padding:12px 14px"><strong>Decision</strong>
    ${lines.length ? `<ul class="sync" style="margin:6px 0">${lines.join('')}</ul>` : '<p class="em" style="margin:6px 0">No decision yet.</p>'}
    ${btns.length ? `<div class="acts" style="margin-top:6px">${btns.join('')}</div>` : ''}</div>`;
}

function decideDialog(app, outcome) {
  return new Promise((resolve) => {
    const paid = Number(app.payment?.total || 0);
    const accepted = app.decision?.outcome === 'accepted';
    const body = outcome === 'accepted'
      ? `<p>Accept <strong>${esc(app.name)}</strong> for ${esc(app.program || '')} ${esc(app.term || '')}?</p>
         ${app.paidAt ? '' : '<p class="notice">The $250 application fee hasn\'t been paid, so it\'s added to their deposit: <strong>$2,500</strong> instead of $2,250. Fee reminders stop.</p>'}
         <p class="em">The student and parents are emailed a personal link to confirm their place: they choose how to pay and pay the ${app.paidAt ? '$2,250' : '$2,500'} deposit. The place is held for ${Number(S.draft.settings.acceptance?.holdDays) || 7} days, and the HubSpot deal moves to Interview Complete. The program's HubSpot record needs a start date.</p>
         <div class="field"><label for="dd-msg">Personal message in the email (optional)</label><textarea id="dd-msg" rows="4" maxlength="2000" placeholder="e.g. It was great to talk with you — we can't wait to have you in Peru!"></textarea></div>`
      : `<p>Decline <strong>${esc(app.name)}</strong>? The student and parents are emailed that we can't offer a place.</p>
         ${app.paidAt ? `<label class="check"><input type="checkbox" id="dd-refund"${accepted ? '' : ' checked'}><span>Refund the application fee ($${paid.toFixed(2)})${accepted ? ' <span class="help">— they were accepted, so under the terms the fee is non-refundable</span>' : ''}</span></label>` : ''}
         <div class="field"><label for="dd-msg">Personal message in the email (optional)</label><textarea id="dd-msg" rows="4" maxlength="2000" placeholder="e.g. We'd love to see you apply for our Fall programs."></textarea></div>
         <p class="em">This can't be undone from the dashboard.</p>`;
    const d = openDialog(`<div class="dlg-head"><h2 class="serif">${outcome === 'accepted' ? 'Accept application' : 'Decline application'}</h2></div>
      <div class="dlg-body">${body}<div class="acts"><button class="btn" data-x>Cancel</button><button class="btn ${outcome === 'accepted' ? 'btn--primary' : 'btn--danger'}" data-ok>${outcome === 'accepted' ? 'Accept and email the family' : 'Decline and email the family'}</button></div></div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    d.querySelector('[data-x]').onclick = () => finish(null);
    d.querySelector('[data-ok]').onclick = () => finish({ message: d.querySelector('#dd-msg')?.value.trim() || '', refund: d.querySelector('#dd-refund') ? d.querySelector('#dd-refund').checked : undefined });
    d.onclose = () => finish(null);
  });
}

function remindersBlock(app) {
  if (!app.step2At || app.paidAt || app.status === 'withdrawn') return '';
  const m = app.reminders || { sent: [] };
  const on = !!S.draft.settings.feeReminders?.enabled;
  const hsNote = (h) => (!h ? '' : h.error ? ` <span class="em">· ⚠️ not logged in HubSpot: ${esc(h.error)}</span>` : h.id ? ' <span class="em">· logged in HubSpot</span>' : '');
  const lines = (m.sent || []).map((x) => `<li>✉️ Reminder ${x.stage} sent ${new Date(x.at).toLocaleString()}${x.to?.length ? ` to ${esc(x.to.join(', '))}` : ''}${hsNote(x.hubspot)}</li>`);
  if (m.lastError) lines.push(`<li>⚠️ Reminder ${esc(m.lastError.stage)} failed ${new Date(m.lastError.at).toLocaleString()} — ${esc(m.lastError.error)} (retried next hour)</li>`);
  if (m.closedAt) lines.push(`<li>Closed ${new Date(m.closedAt).toLocaleDateString()} — fee never paid. They can still pay with their link.</li>`);
  if (m.stopped) lines.push(`<li>Stopped ${new Date(m.stopped.at).toLocaleString()}${m.stopped.by ? ` by ${esc(m.stopped.by)}` : ''}</li>`);
  const btn = m.stopped || m.closedAt
    ? `<button class="btn btn--sm" id="rem-toggle" data-stop="0">${m.closedAt ? 'Re-open and resume reminders' : 'Resume reminders'}</button>`
    : `<button class="btn btn--sm" id="rem-toggle" data-stop="1">Stop reminders</button>`;
  return `<div class="panel" style="padding:12px 14px"><strong>Fee reminders</strong> <span class="em">${on ? '' : '(switched off in Fee, interview &amp; text)'}</span>
    <ul class="sync" style="margin:6px 0">${lines.join('') || '<li class="em">None sent yet.</li>'}</ul>${btn}</div>`;
}

async function showApplication(id) {
  const d = openDialog('<div class="dlg-body loading">Loading…</div>');
  let app;
  try { ({ application: app } = await api('GET', { action: 'application', id })); }
  catch (err) { d.innerHTML = `<div class="dlg-body"><div class="notice notice--bad">${esc(err.message)}</div></div>`; return; }
  const answers = app.answers || {};
  const groups = [];
  for (const st of S.draft.steps) for (const sec of st.sections) {
    const rows = sec.fields.filter((f) => f.type !== 'html' && answers[f.key] != null && answers[f.key] !== '').map((f) => {
      let v = answers[f.key];
      if (f.type === 'file') v = (v || []).map((x) => `<a href="${API}?action=file&id=${encodeURIComponent(x.id)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(', ');
      else if (f.type === 'fullname') v = esc(`${v.first || ''} ${v.last || ''}`);
      else if (f.type === 'address') v = esc(['addr_line1', 'addr_line2', 'city', 'state', 'postal'].map((k) => v[k]).filter(Boolean).join(', '));
      else if (f.type === 'phone') v = esc(`+${v.cc} ${v.number}`);
      else v = esc(Array.isArray(v) ? v.join(', ') : String(v));
      return `<dt>${esc(f.label || f.key)}</dt><dd>${v}</dd>`;
    });
    if (rows.length) groups.push(`<h3>${esc(sec.title || '')}</h3>${rows.join('')}`);
  }
  const sync = app.syncRaw || {};
  const syncRow = (k, label) => { const s = sync[k]; if (!s) return ''; return `<li>${s.ok ? '✅' : '⚠️'} ${label}${s.ok ? '' : ` — ${esc(s.error || '')}`}${s.dropped?.length ? ` <span class="em">(skipped: ${esc(s.dropped.join(', '))})</span>` : ''}${s.warning ? ` <span class="em">${esc(s.warning)}</span>` : ''}</li>`; };
  const portal = (deal) => deal ? `<a href="https://app.hubspot.com/contacts/3855728/record/0-3/${encodeURIComponent(deal)}" target="_blank" rel="noopener">Open deal in HubSpot ↗</a>` : '';
  d.innerHTML = `<div class="dlg-head"><div><h2 class="serif">${esc(app.name)}</h2><div class="em">${esc(app.email)} · ${esc(app.program || '')} ${esc(app.term || '')}</div></div><button class="btn btn--sm" data-x>Close</button></div>
    <div class="dlg-body">
      <p><span class="chip chip--info">${esc(STATUS_LABEL[app.status])}</span>
        ${app.interview?.label ? ` · Interview: ${esc(app.interview.label)}${app.interview.source === 'hubspot' ? ' <span class="em">(booked outside the application — found in HubSpot)</span>' : ''}` : ''}
        ${needsInterview(app) ? ` · <span class="chip chip--changes">Interview needed</span> ${esc(app.interview.reasonLabel || '')}${app.interview.note ? ` — “${esc(app.interview.note)}”` : ''}` : ''}
        ${app.paidAt ? ` · Paid $${Number(app.payment?.total || 0).toFixed(2)} on ${new Date(app.paidAt).toLocaleDateString()}` : ''}</p>
      <ul class="sync">${syncRow('jf1', `Step 1 saved to Jotform${app.jotformStep1Id ? ` (#${esc(app.jotformStep1Id)})` : ''}`)}${syncRow('jf2', `Application saved to Jotform${app.jotformStep2Id ? ` (#${esc(app.jotformStep2Id)})` : ''}`)}
        ${syncRow('alert1', `Admissions alerted${sync.alert1?.to ? ` (${esc(sync.alert1.to.join(', '))})` : ''}`)}${syncRow('alert1Error', 'Admissions alert email')}${syncRow('hsContact', 'HubSpot contact')}${syncRow('hsDeal', 'HubSpot deal created')}${syncRow('hsStep2', `Deal in ${esc(sync.hsStep2?.pipeline || 'PD Applications')}${sync.hsStep2?.stage ? ` / ${esc(sync.hsStep2.stage)}` : ''}`)}${syncRow('hsStep2Error', 'Moving the deal to PD Applications')}${syncRow('hsInterview', 'Interview noted in HubSpot')}${syncRow('interviewNeeded', `Admissions asked to arrange the interview${sync.interviewNeeded?.to ? ` (${esc(sync.interviewNeeded.to.join(', '))})` : ''}`)}${syncRow('interviewNeededError', 'Interview-needed alert')}${syncRow('hsFamily', `Parents linked${sync.hsFamily?.parents ? ` (${sync.hsFamily.parents.map((p) => esc(p.email)).join(', ') || 'none given'})` : ''}`)}${syncRow('hsFamilyError', 'Linking parents')}${syncRow('hsProgram', `Linked to program record${sync.hsProgram?.record ? `: ${esc(sync.hsProgram.record.name)} (${esc(sync.hsProgram.record.season || '')} ${esc(sync.hsProgram.record.year || '')})` : ''}`)}${syncRow('hsProgramError', 'Program record')}
        ${syncRow('hsPaid', `Fee recorded in HubSpot${sync.hsPaid?.pipeline ? ` → ${esc(sync.hsPaid.pipeline)} / ${esc(sync.hsPaid.stage || '')}` : ''}`)}
        ${syncRow('feeEmail', `Fee confirmation emailed${sync.feeEmail?.to ? ` to ${esc(sync.feeEmail.to.join(', '))}` : ''}${sync.feeEmail?.termsVersion ? ` (terms v${esc(sync.feeEmail.termsVersion)})` : ''}`)}${syncRow('feeEmailError', 'Fee confirmation email')}${syncRow('feeEmailLog', `Fee confirmation logged in HubSpot${sync.feeEmailLog?.contacts ? ` (${sync.feeEmailLog.contacts} contact${sync.feeEmailLog.contacts === 1 ? '' : 's'} + deal)` : ''}`)}${syncRow('feeAlert', 'Admissions told the fee was paid')}${syncRow('feeAlertError', 'Fee-paid alert')}
        ${syncRow('hsError', 'HubSpot')}${syncRow('hsPaidError', 'HubSpot payment update')}${syncRow('hsInterviewError', 'HubSpot interview note')}</ul>
      ${decisionBlock(app)}
      ${remindersBlock(app)}
      <div class="acts"><button class="btn btn--sm" id="resync">Retry sync</button>${portal(app.hubspotDealId)}
        ${app.enrolment?.withdrawn ? '' : `<button class="btn btn--sm ${app.status === 'withdrawn' ? '' : 'btn--danger'}" id="withdraw">${app.status === 'withdrawn' ? 'Restore application' : 'Mark withdrawn'}</button>`}</div>
      <dl class="ans">${groups.join('') || '<dd>No answers.</dd>'}</dl>
      ${app.attribution && Object.keys(app.attribution).length ? `<details><summary class="em">Attribution</summary><pre class="em">${esc(JSON.stringify(app.attribution, null, 2))}</pre></details>` : ''}
    </div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('#resync').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Syncing…';
    try { await api('POST', {}, { action: 'resync', id }); toast('Sync finished.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 6000); e.currentTarget.disabled = false; e.currentTarget.textContent = 'Retry sync'; }
  });
  for (const [sel, outcome] of [['#dec-accept', 'accepted'], ['#dec-decline', 'declined']]) {
    d.querySelector(sel)?.addEventListener('click', async () => {
      const choice = await decideDialog(app, outcome);
      if (!choice) { showApplication(id); return; }
      toast(outcome === 'accepted' ? 'Accepting…' : 'Declining…');
      try {
        await api('POST', {}, { action: 'decide', id, outcome, ...choice });
        toast(outcome === 'accepted' ? 'Accepted. The family has been emailed their acceptance link.' : 'Declined. The family has been emailed.', 6000);
      } catch (err) { toast(esc(err.message), 9000); }
      showApplication(id); renderApps();
    });
  }
  d.querySelector('#dec-resend')?.addEventListener('click', async (e) => {
    if (!confirm(`Email ${app.name} and their parents a personal link to confirm their place and pay the deposit?`)) return;
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Sending…';
    try { await api('POST', {}, { action: 'resend-acceptance', id }); toast('Acceptance email sent.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 9000); showApplication(id); }
  });
  d.querySelector('#dec-extend')?.addEventListener('click', async (e) => {
    const days = prompt('Hold their place for how many more days (from today)?', '7');
    if (days == null) return;
    e.currentTarget.disabled = true;
    try { await api('POST', {}, { action: 'extend-hold', id, days: Number(days) }); toast('Hold extended. Their acceptance link works again.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 7000); e.currentTarget.disabled = false; }
  });
  d.querySelector('#rem-toggle')?.addEventListener('click', async (e) => {
    const stop = e.currentTarget.dataset.stop === '1';
    e.currentTarget.disabled = true;
    try { await api('POST', {}, { action: 'reminders', id, stop }); toast(stop ? 'Reminders stopped for this applicant.' : 'Reminders resumed.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 7000); e.currentTarget.disabled = false; }
  });
  d.querySelector('#withdraw')?.addEventListener('click', async () => {
    const dep = ['paid', 'processing'].includes(app.enrolment?.deposit?.status);
    let reason = '';
    if (app.status !== 'withdrawn' && dep) {
      const open = (app.enrolment.schedule || []).filter((p) => ['scheduled', 'failed', 'needs_admissions', 'due'].includes(p.status));
      reason = prompt(`Withdraw ${app.name}?\n\nThis cancels ${open.length} upcoming payment${open.length === 1 ? '' : 's'} (${money(open.reduce((a, p) => a + p.amount, 0))}), keeps what's been paid (per the terms) and moves the HubSpot deal to Cancelled. The family isn't emailed.\n\nReason (optional):`, '');
      if (reason == null) return;
    }
    try {
      const out = await api('POST', {}, { action: 'withdraw', id, withdrawn: app.status !== 'withdrawn', reason });
      if (out.withdraw) toast(`Withdrawn. Kept ${money(out.withdraw.kept)}; cancelled ${out.withdraw.cancelled} payment${out.withdraw.cancelled === 1 ? '' : 's'}.`, 7000);
      d.close(); renderApps();
    } catch (err) { toast(esc(err.message), 7000); }
  });
  d.querySelector('#pay-pause')?.addEventListener('click', async (e) => {
    const paused = e.currentTarget.dataset.paused !== '1';
    e.currentTarget.disabled = true;
    try { await api('POST', {}, { action: 'payments-pause', id, paused }); toast(paused ? 'Automatic payments paused for this family.' : 'Automatic payments resumed.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 7000); e.currentTarget.disabled = false; }
  });
  d.querySelectorAll('[data-markpaid]').forEach((b) => b.addEventListener('click', async () => {
    const reference = prompt('Mark this payment as paid outside Stripe (e.g. a bank transfer)? It won\'t be charged automatically.\n\nReference (e.g. Wise transfer ID):', '');
    if (reference == null) return;
    b.disabled = true;
    try { await api('POST', {}, { action: 'payment-mark-paid', id, item: Number(b.dataset.markpaid), reference }); toast('Marked paid.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 7000); b.disabled = false; }
  }));
  d.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api('POST', {}, { action: 'payment-retry', id, item: Number(b.dataset.retry) }); toast('It will be tried again within the hour.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 7000); b.disabled = false; }
  }));
}

// ── boot ────────────────────────────────────────────────────────────────────
function loadForm(form, lint) {
  S.form = form; S.draft = clone(form.draft); S.rev = form.draftRev; S.lint = lint || lintSchema(S.draft);
}

async function boot() {
  const style = document.createElement('style');
  style.textContent = FORM_CSS;
  document.head.appendChild(style);
  $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); }));
  $('#btn-publish').addEventListener('click', publish);
  $('#btn-discard').addEventListener('click', discard);
  $('#btn-versions').addEventListener('click', () => showVersions().catch((e) => toast(esc(e.message))));
  window.addEventListener('beforeunload', (e) => { if (S.dirty || S.saving || S.terms?.dirty || S.terms?.saving) { e.preventDefault(); e.returnValue = ''; } });

  let out;
  try { out = await api('GET', { action: 'get' }); }
  catch (err) { $('#app').innerHTML = `<div class="page"><div class="notice notice--bad">${esc(err.message)}</div></div>`; return; }
  S.user = out.user; S.applySite = out.applySite;
  if (!out.form) {
    // First run: seed from the live Jotform forms (snapshot in seed-schema.json).
    const seed = await (await fetch('/apply-form/seed-schema.json', { credentials: 'include' })).json();
    try { out = await api('POST', {}, { action: 'init', schema: seed }); }
    catch (err) { $('#app').innerHTML = `<div class="page"><div class="notice notice--bad">${esc(err.message)}</div></div>`; return; }
    notice('info', 'The form has been set up from your current Jotform application forms. Check the Programs tab (Japan Summer Program has no price yet), then Publish to go live.');
  }
  loadForm(out.form, out.lint);
  render();
  api('GET', { action: 'hubspot' }).then((h) => { S.hubspot = h; if (S.tab === 'programs' || (S.tab === 'fields' && S.sel)) render(); }).catch(() => { S.hubspot = { pdPrograms: [], contactProps: [], dealProps: [], warning: 'HubSpot properties could not be loaded.' }; });
}

boot();
