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
      </div></div>
    <div class="panel"><h2 class="serif">Interview</h2><p class="sub">Step 3 embeds this HubSpot scheduling page, prefilled with the applicant's name and email. Booking a time moves them on to payment automatically.</p>
      <div class="field"><label for="s-meet">HubSpot meetings link</label><input type="url" id="s-meet" value="${esc(st.meetingUrl || '')}" placeholder="https://meetings.hubspot.com/…"></div>
      <label class="check"><input type="checkbox" id="s-skip"${st.allowSkipInterview ? ' checked' : ''}> Let applicants skip booking and go straight to payment</label></div>
    <div class="panel"><h2 class="serif">Wording</h2><p class="sub">Headings and short messages on each screen.</p>
      <div class="cols"><div>${txt('welcomeTitle', 'Step 1 heading', 1)}${txt('welcomeBody', 'Step 1 intro', 3)}${txt('interviewTitle', 'Interview heading', 1)}${txt('interviewBody', 'Interview intro', 3)}</div>
      <div>${txt('paymentTitle', 'Payment heading', 1)}${txt('paymentBody', 'Payment intro', 3)}${txt('doneTitle', 'Finished heading', 1)}${txt('doneBody', 'Finished message', 3)}</div></div></div>
    <div class="panel"><h2 class="serif">Jotform mirror</h2><p class="sub">While pd-apply's <code>JOTFORM_MIRROR</code> is on, each step is also saved into these Jotform forms (same field IDs) so anything still reading Jotform keeps working. Once the portals read pd-apply directly you can turn the mirror off and archive both forms.</p>
      <div class="cols"><div class="field"><label for="s-jf1">Step 1 form ID</label><input type="text" id="s-jf1" value="${esc(st.jotform.step1 || '')}"></div>
      <div class="field"><label for="s-jf2">Full application form ID</label><input type="text" id="s-jf2" value="${esc(st.jotform.step2 || '')}"></div></div></div>
  </div>`;
  const recalc = () => { const f = Number(st.appFee) || 0; const r = Number(st.cardFeeRate) || 0; $('#s-total').textContent = `$${(f + Math.round(f * r * 100) / 100).toFixed(2)}`; };
  $('#s-fee').addEventListener('input', (e) => { st.appFee = Number(e.target.value); recalc(); changed({ rerender: false }); });
  $('#s-rate').addEventListener('input', (e) => { st.cardFeeRate = Math.round(Number(e.target.value) * 10) / 1000; recalc(); changed({ rerender: false }); });
  $('#s-meet').addEventListener('input', (e) => { st.meetingUrl = e.target.value.trim(); changed({ rerender: false }); });
  $('#s-skip').addEventListener('change', (e) => { st.allowSkipInterview = e.target.checked; changed({ rerender: false }); });
  $('#s-jf1').addEventListener('input', (e) => { st.jotform.step1 = e.target.value.trim(); changed({ rerender: false }); });
  $('#s-jf2').addEventListener('input', (e) => { st.jotform.step2 = e.target.value.trim(); changed({ rerender: false }); });
  $$('[data-text]').forEach((el) => el.addEventListener('input', () => { st.texts[el.dataset.text] = el.value; changed({ rerender: false }); }));
}

// ── tab: applications ───────────────────────────────────────────────────────
const STATUS_LABEL = { step1: 'Started', step2: 'Application in', interview: 'Interview booked', paid: 'Fee paid', withdrawn: 'Withdrawn' };

async function renderApps() {
  const a = S.apps;
  $('#app').innerHTML = `<div class="page"><div class="filters" id="flt"></div><div id="apps-body" class="loading">Loading applications…</div></div>`;
  try {
    const out = await api('GET', { action: 'applications', status: a.status, q: a.q });
    a.list = out.applications; a.counts = out.counts;
  } catch (err) { $('#apps-body').innerHTML = `<div class="notice notice--bad">${esc(err.message)}</div>`; return; }
  const total = Object.entries(a.counts).filter(([k]) => k !== 'withdrawn').reduce((x, [, n]) => x + n, 0);
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
      <td><div class="dots" title="${esc(STATUS_LABEL[r.status])}"><span class="on"></span><span class="${r.step2At ? 'on' : ''}"></span><span class="${r.interviewAt ? 'on' : ''}"></span><span class="${r.paidAt ? 'paid' : ''}"></span></div><div class="em">${esc(STATUS_LABEL[r.status])}</div></td>
      <td class="em">${new Date(r.createdAt).toLocaleDateString()}</td>
      <td>${r.sync.ok ? '<span class="chip chip--live">OK</span>' : `<span class="chip chip--bad" title="${esc(r.sync.problems.join('\n'))}">Needs a look</span>`}</td></tr>`).join('')}
  </tbody></table></div>`;
  $$('.apps tr[data-id]').forEach((tr) => {
    const open = () => showApplication(tr.dataset.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
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
        ${app.interview?.label ? ` · Interview: ${esc(app.interview.label)}` : ''}
        ${app.paidAt ? ` · Paid $${Number(app.payment?.total || 0).toFixed(2)} on ${new Date(app.paidAt).toLocaleDateString()}` : ''}</p>
      <ul class="sync">${syncRow('jf1', `Step 1 saved to Jotform${app.jotformStep1Id ? ` (#${esc(app.jotformStep1Id)})` : ''}`)}${syncRow('jf2', `Application saved to Jotform${app.jotformStep2Id ? ` (#${esc(app.jotformStep2Id)})` : ''}`)}
        ${syncRow('alert1', `Admissions alerted${sync.alert1?.to ? ` (${esc(sync.alert1.to.join(', '))})` : ''}`)}${syncRow('alert1Error', 'Admissions alert email')}${syncRow('hsContact', 'HubSpot contact')}${syncRow('hsDeal', 'HubSpot deal created')}${syncRow('hsStep2', `Deal in ${esc(sync.hsStep2?.pipeline || 'PD Applications')}${sync.hsStep2?.stage ? ` / ${esc(sync.hsStep2.stage)}` : ''}`)}${syncRow('hsStep2Error', 'Moving the deal to PD Applications')}${syncRow('hsInterview', 'Interview noted in HubSpot')}${syncRow('hsFamily', `Parents linked${sync.hsFamily?.parents ? ` (${sync.hsFamily.parents.map((p) => esc(p.email)).join(', ') || 'none given'})` : ''}`)}${syncRow('hsFamilyError', 'Linking parents')}${syncRow('hsProgram', `Linked to program record${sync.hsProgram?.record ? `: ${esc(sync.hsProgram.record.name)} (${esc(sync.hsProgram.record.season || '')} ${esc(sync.hsProgram.record.year || '')})` : ''}`)}${syncRow('hsProgramError', 'Program record')}
        ${syncRow('hsPaid', `Fee recorded in HubSpot${sync.hsPaid?.pipeline ? ` → ${esc(sync.hsPaid.pipeline)} / ${esc(sync.hsPaid.stage || '')}` : ''}`)}
        ${syncRow('hsError', 'HubSpot')}${syncRow('hsPaidError', 'HubSpot payment update')}${syncRow('hsInterviewError', 'HubSpot interview note')}</ul>
      <div class="acts"><button class="btn btn--sm" id="resync">Retry sync</button>${portal(app.hubspotDealId)}
        <button class="btn btn--sm ${app.status === 'withdrawn' ? '' : 'btn--danger'}" id="withdraw">${app.status === 'withdrawn' ? 'Restore application' : 'Mark withdrawn'}</button></div>
      <dl class="ans">${groups.join('') || '<dd>No answers.</dd>'}</dl>
      ${app.attribution && Object.keys(app.attribution).length ? `<details><summary class="em">Attribution</summary><pre class="em">${esc(JSON.stringify(app.attribution, null, 2))}</pre></details>` : ''}
    </div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('#resync').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Syncing…';
    try { await api('POST', {}, { action: 'resync', id }); toast('Sync finished.'); showApplication(id); renderApps(); }
    catch (err) { toast(esc(err.message), 6000); e.currentTarget.disabled = false; e.currentTarget.textContent = 'Retry sync'; }
  });
  d.querySelector('#withdraw').addEventListener('click', async () => {
    try { await api('POST', {}, { action: 'withdraw', id, withdrawn: app.status !== 'withdrawn' }); d.close(); renderApps(); }
    catch (err) { toast(esc(err.message)); }
  });
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
  window.addEventListener('beforeunload', (e) => { if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ''; } });

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
