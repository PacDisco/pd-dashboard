// Unearthed Application Form — editor for the ue-apply site
// (apply.unearthededucation.org). Tabs: Questions · Permissions packet ·
// Trips & links · Wording & emails · Applications. API: /api/ue-apply-forms.
// Two forms, switched in the header: Students, and Teachers & trip leaders
// (one form for both; /<trip>/teacher and /<trip>/leader).
import * as K from './form-kit.mjs';
import { DEFAULT_WAIVER, waiverOf } from './waiver-kit.mjs';
import { renderWaiver, WAIVER_CSS } from './waiver-ui.mjs';
import { defaultEmail } from './emails.mjs';

const API = '/api/ue-apply-forms';
const APPLY_SITE = 'https://apply.unearthededucation.org';
const HS = 'https://app.hubspot.com/contacts/3855728/record';
const $ = (s, r = document) => r.querySelector(s);
const esc = K.esc;
const app = $('#app');
const S = { formKind: 'student', schemas: {}, tab: 'fields', form: null, draft: null, lint: [], step: 'step1', pick: null, hub: null, programs: null, trips: null, apps: null, appFilter: { status: '', trip: '', q: '', kind: '' }, saving: null };
const style = document.createElement('style'); style.textContent = K.FORM_CSS + WAIVER_CSS; document.head.appendChild(style);

// ── api / chrome ────────────────────────────────────────────────────────────
// Form-specific actions carry which form (students / teachers & leaders).
const FORM_ACTIONS = new Set(['get', 'versions', 'version', 'save', 'publish', 'discard', 'restore']);
const TEACHER_MODE = () => S.formKind === 'teacher';
async function api(method, params = {}, body) {
  if (FORM_ACTIONS.has(params.action) && TEACHER_MODE()) params = { ...params, form: 'teacher' };
  if (body && FORM_ACTIONS.has(body.action) && TEACHER_MODE()) body = { ...body, form: 'teacher' };
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* binary */ }
  if (res.status === 401) notice('bad', 'Your sign-in has expired. <a href="/">Sign in again</a>.');
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { data });
  return data;
}
function notice(kind, html) { $('#notices').innerHTML = html ? `<div class="notice notice--${kind}">${html}</div>` : ''; }
function toast(t, ms = 4000) { const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = t; document.body.appendChild(el); setTimeout(() => el.remove(), ms); }
function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; d.showModal(); d.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => d.close())); return d; }
const clone = (o) => JSON.parse(JSON.stringify(o));
const when = (d) => (d ? new Date(d).toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function changed() {
  setSave('Unsaved…');
  clearTimeout(S.saving);
  S.saving = setTimeout(save, 900);
  S.lint = K.lintSchema(S.draft);
  chrome();
}
async function save() {
  try {
    const r = await api('POST', {}, { action: 'save', draft: S.draft, rev: S.form?.draftRev ?? 0 });
    S.form = r.form; S.lint = r.lint; setSave('Saved'); chrome();
  } catch (e) {
    setSave('Not saved', true);
    if (e.data?.conflict) notice('bad', 'Someone else changed the form. <a href="">Reload</a> to see their changes (yours since then are not saved).');
    else toast(esc(e.message));
  }
}
function setSave(t, err) { const el = $('#save-state'); el.textContent = t; el.classList.toggle('err', !!err); }
function chrome() {
  const f = S.form;
  $('#btn-import').classList.toggle('hidden', TEACHER_MODE());
  document.querySelector('.tabs [data-tab=waiver]').textContent = TEACHER_MODE() ? 'Waiver' : 'Permissions packet';
  document.querySelectorAll('#formKind [data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === S.formKind)));
  $('#status-chip').innerHTML = !f ? '<span class="chip chip--draft">Not set up</span>' : !f.published ? '<span class="chip chip--draft">Draft — not live yet</span>' : f.changed ? '<span class="chip chip--changes">Unpublished changes</span>' : '<span class="chip chip--live">Live</span>';
  $('#btn-discard').classList.toggle('hidden', !f?.changed);
  $('#btn-publish').disabled = !S.draft;
}

$('#btn-publish').addEventListener('click', async () => {
  clearTimeout(S.saving); await save();
  const errs = S.lint.filter((l) => l.level === 'error');
  if (errs.length) { toast(`Fix first: ${esc(errs[0].message)}`); return; }
  const note = prompt('Publish — what changed? (optional, shown under Versions)');
  if (note === null) return;
  try { await api('POST', {}, { action: 'publish', rev: S.form.draftRev, note }); toast('Published — live within about 30 seconds.'); await load(); }
  catch (e) { toast(esc(e.message), 7000); }
});
$('#btn-discard').addEventListener('click', async () => {
  if (!confirm('Throw away the unpublished changes and go back to what is live?')) return;
  try { const r = await api('POST', {}, { action: 'discard' }); S.form = r.form; S.draft = clone(r.form.draft); S.lint = r.lint; render(); chrome(); } catch (e) { toast(esc(e.message)); }
});
$('#btn-versions').addEventListener('click', async () => {
  const { versions } = await api('GET', { action: 'versions' });
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Versions</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    ${versions.length ? `<table class="grid"><tr><th>When</th><th>What</th><th>By</th><th></th></tr>${versions.map((v) => `<tr><td>${when(v.created_at)}</td><td>${esc(v.kind)} · rev ${v.rev}${v.note ? ` — ${esc(v.note)}` : ''}</td><td>${esc(v.created_by || '')}</td><td><button class="btn btn--sm" data-restore="${v.id}">Copy into draft</button></td></tr>`).join('')}</table>` : '<p class="muted">Nothing published yet.</p>'}</div>`);
  d.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', {}, { action: 'restore', versionId: Number(b.dataset.restore) });
    S.form = r.form; S.draft = clone(r.form.draft); S.lint = r.lint; d.close(); render(); chrome(); toast('Copied into the draft — Publish to make it live.');
  }));
});
$('#btn-import').addEventListener('click', () => importDialog());

function importDialog() {
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Import questions from Jotform</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    <p>Rebuilds the questions from the live Jotform form, keeping each Jotform field ID so applications land in the same Jotform fields the portals read. The permissions packet, wording and emails you've set here are kept. The result is a <strong>draft</strong> — nothing changes for applicants until you Publish.</p>
    ${S.draft ? '<p class="lint lint--warn">This replaces the current questions in the draft (it\'s kept under Versions).</p>' : ''}
    <div class="field"><label for="jfId">Jotform form ID</label><input id="jfId" type="text" value="${esc(S.draft?.settings?.jotform?.formId || '251396787451873')}"></div>
    <div class="acts"><button class="btn btn--primary" id="doImport">Import</button></div><div id="impOut"></div></div>`);
  d.querySelector('#doImport').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Importing…';
    try {
      const r = await api('POST', {}, { action: 'import-jotform', formId: d.querySelector('#jfId').value });
      S.form = r.form; S.draft = clone(r.form.draft); S.lint = r.lint; chrome(); S.tab = 'fields'; render();
      d.querySelector('#impOut').innerHTML = `<h3>Imported — please check:</h3><ul class="report">${(r.report || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>Nothing unusual.</li>'}</ul>`;
    } catch (err) { d.querySelector('#impOut').innerHTML = `<p class="lint lint--error">${esc(err.message)}</p>`; }
    e.target.disabled = false; e.target.textContent = 'Import';
  });
}

document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); }));

document.querySelectorAll('#formKind [data-kind]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.kind === S.formKind) return;
  clearTimeout(S.saving); if (S.draft && $('#save-state').textContent === 'Unsaved…') await save();
  S.formKind = b.dataset.kind; S.pick = null; S.step = 'step1';
  app.innerHTML = '<div class="page"><div class="loading">Loading…</div></div>';
  await load();
}));

function teacherSetup() {
  app.innerHTML = `<div class="page"><div class="empty"><h2>Set up the teacher &amp; trip leader form</h2>
    <p>Starts as a copy of the student form with the parent / guardian questions taken out and one emergency contact added. You can then change anything — it's a separate form, so the student form isn't affected.</p>
    <p class="muted">Teachers apply at <code>${esc(APPLY_SITE.replace('https://', ''))}/&lt;trip&gt;/teacher</code>, trip leaders at <code>…/&lt;trip&gt;/leader</code>. They sign the waiver themselves; there's no deposit and no deal. They only get the leader portal when you approve them under Applications.</p>
    <button class="btn btn--primary" id="mkTeacher">Create from the student form</button><div id="mkOut"></div></div></div>`;
  $('#mkTeacher').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', {}, { action: 'create-teacher-form' });
      S.form = r.form; S.draft = clone(r.form.draft); S.lint = r.lint; chrome(); S.tab = 'fields'; render();
      toast(`Created. Left out: ${esc((r.removed || []).join(', ') || 'nothing')}. Check the questions, then Publish.`, 9000);
    } catch (err) { $('#mkOut').innerHTML = `<p class="lint lint--error">${esc(err.message)}</p>`; e.target.disabled = false; }
  });
}

function render() {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  if (S.tab !== 'trips' && S.tab !== 'apps' && !S.draft && TEACHER_MODE()) return teacherSetup();
  if (S.tab !== 'trips' && S.tab !== 'apps' && !S.draft) {
    app.innerHTML = `<div class="page"><div class="empty"><h2>Set up the form</h2><p>Start from the live Jotform application — every question, its options and its "show when…" rules are copied, and each keeps its Jotform field ID.</p><button class="btn btn--primary" id="firstImport">Import from Jotform</button></div></div>`;
    $('#firstImport').addEventListener('click', importDialog);
    return;
  }
  // Tabs that load data show the error instead of spinning forever.
  Promise.resolve()
    .then(() => ({ fields: renderFields, waiver: renderWaiverTab, trips: renderTrips, settings: renderSettings, apps: renderApps })[S.tab]())
    .catch((e) => { app.innerHTML = `<div class="page"><p class="lint lint--error">${esc(e.message)}</p></div>`; });
}

// ── tab: questions ──────────────────────────────────────────────────────────
const stepObj = () => S.draft.steps.find((s) => s.key === S.step);
function locate(key) {
  for (const st of S.draft.steps) for (const sec of st.sections) { const i = sec.fields.findIndex((f) => f.key === key); if (i >= 0) return { st, sec, i, field: sec.fields[i] }; }
  return null;
}

function renderFields() {
  const errs = S.lint.filter((l) => l.level === 'error'); const warns = S.lint.filter((l) => l.level === 'warn');
  app.innerHTML = `<div class="work">
    <div class="canvas"><div class="stepbar"><div class="seg">${S.draft.steps.map((s) => `<button data-step="${s.key}" aria-pressed="${s.key === S.step}">${esc(s.title || s.key)}</button>`).join('')}</div>
      <span class="muted" style="font-size:12px">Click a question to edit it. Greyed = hidden from applicants.</span></div>
      <div class="sheet"><div id="preview"></div></div></div>
    <aside class="inspector"><div class="insp-head"><h2 id="insp-title">Questions</h2><button class="btn btn--sm hidden" id="insp-back">← All questions</button></div><div class="insp-body" id="insp"></div></aside></div>`;
  if (errs.length || warns.length) $('#insp').insertAdjacentHTML('beforebegin', `${errs.length ? `<div class="lint lint--error" style="margin:12px 14px 0"><strong>Fix before publishing</strong><ul>${errs.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>` : ''}${warns.length ? `<div class="lint lint--warn" style="margin:12px 14px 0"><ul>${warns.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>` : ''}`);
  app.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { S.step = b.dataset.step; S.pick = null; renderFields(); }));
  $('#insp-back').addEventListener('click', () => { S.pick = null; inspector(); });
  preview();
  inspector();
}

let prev = null;
function preview() {
  prev = K.renderStep($('#preview'), S.draft, S.step, { preview: true, onPick: (key) => { S.pick = key; inspector(); } });
  if (S.pick) prev?.highlight(S.pick);
}

function inspector() {
  const box = $('#insp');
  $('#insp-back').classList.toggle('hidden', !S.pick);
  if (S.pick && locate(S.pick)) { fieldEditor(box, locate(S.pick)); return; }
  $('#insp-title').textContent = `${stepObj().title || ''} — questions`;
  const st = stepObj();
  box.innerHTML = `<div class="field"><label>Page title</label><input id="stTitle" value="${esc(st.title || '')}"></div>
    <div class="field"><label>Intro under the title</label><textarea id="stIntro" rows="2">${esc(st.intro || '')}</textarea></div>
    <div class="field"><label>Button</label><input id="stBtn" value="${esc(st.submitLabel || '')}"></div>
    ${st.sections.map((sec, si) => `<div class="sec"><div class="sec__head"><span class="t" data-sec="${si}">${esc(sec.title || '(untitled section)')}</span>
      <button class="btn btn--icon btn--sm" data-secup="${si}" title="Move section up">↑</button></div>
      ${sec.fields.map((f) => `<div class="frow${f.hidden || f.type === 'hidden' ? ' off' : ''}"><span class="t" data-pick="${esc(f.key)}">${esc(f.label || f.key)}</span>
        ${f.required ? '<span class="tag req">required</span>' : ''}${f.showIf?.rules?.length ? '<span class="tag if">if…</span>' : ''}${f.sensitive ? '<span class="tag">🔒</span>' : ''}<span class="ty">${esc(K.FIELD_TYPES[f.type]?.label || f.type)}</span></div>`).join('')}
      <div class="addrow"><button class="btn btn--sm" data-add="${si}">+ Add question</button></div></div>`).join('')}
    <button class="btn btn--sm" id="addSec">+ Add section</button>`;
  const bind = (id, k) => box.querySelector(id).addEventListener('input', (e) => { st[k] = e.target.value; changed(); preview(); });
  bind('#stTitle', 'title'); bind('#stIntro', 'intro'); bind('#stBtn', 'submitLabel');
  box.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('click', () => { S.pick = el.dataset.pick; prev?.highlight(S.pick); inspector(); }));
  box.querySelectorAll('[data-sec]').forEach((el) => el.addEventListener('click', () => sectionEditor(st, Number(el.dataset.sec))));
  box.querySelectorAll('[data-secup]').forEach((el) => el.addEventListener('click', () => { const i = Number(el.dataset.secup); if (i > 0) { [st.sections[i - 1], st.sections[i]] = [st.sections[i], st.sections[i - 1]]; changed(); preview(); inspector(); } }));
  box.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => addField(st.sections[Number(el.dataset.add)])));
  $('#addSec').addEventListener('click', () => { st.sections.push({ key: `s${Date.now().toString(36)}`, title: 'New section', intro: '', fields: [] }); changed(); preview(); inspector(); });
}

function sectionEditor(st, si) {
  const sec = st.sections[si];
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Section</h2><button class="btn btn--sm" data-x>Done</button></div><div class="dlg-body">
    <div class="field"><label>Title</label><input id="sT" value="${esc(sec.title || '')}"></div>
    <div class="field"><label>Intro (optional; bold, links and lists allowed)</label><textarea id="sI">${esc(sec.intro || '')}</textarea></div>
    ${sec.fields.length ? '' : '<button class="btn btn--sm btn--danger" id="sDel">Delete this empty section</button>'}</div>`);
  d.querySelector('#sT').addEventListener('input', (e) => { sec.title = e.target.value; changed(); preview(); });
  d.querySelector('#sI').addEventListener('input', (e) => { sec.intro = e.target.value; changed(); preview(); });
  d.querySelector('#sDel')?.addEventListener('click', () => { st.sections.splice(si, 1); changed(); d.close(); preview(); inspector(); });
  d.addEventListener('close', () => inspector(), { once: true });
}

function uniqueKey(base) { let k = base || 'question'; let n = 2; while (locate(k)) k = `${base}${n++}`; return k; }
const camel = (s) => { const w = String(s).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 4); const k = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join(''); return /^[A-Za-z]/.test(k) ? k : `q${k}`; };

function addField(sec) {
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Add a question</h2><button class="btn btn--sm" data-x>Cancel</button></div><div class="dlg-body">
    <div class="field"><label>Question</label><input id="nL" placeholder="e.g. Do you have any dietary requirements?"></div>
    <div class="field"><label>Type</label><select id="nT">${Object.entries(K.FIELD_TYPES).filter(([k]) => k !== 'hidden').map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
    <p class="kv">New questions aren't in Jotform, so the portals won't show them unless you also add the question to the Jotform form and enter its field ID here afterwards. They're always saved on the application and can go to HubSpot.</p>
    <div class="acts"><button class="btn btn--primary" id="nGo">Add</button></div></div>`);
  d.querySelector('#nGo').addEventListener('click', () => {
    const label = d.querySelector('#nL').value.trim() || 'New question';
    const type = d.querySelector('#nT').value;
    const f = { key: uniqueKey(camel(label)), qid: `x${K.nextQid(S.draft)}`, type, label };
    if (K.FIELD_TYPES[type]?.options) f.options = ['Yes', 'No'];
    if (type === 'html') f.html = `<p>${esc(label)}</p>`;
    if (type === 'file') { f.accept = 'image/*,.pdf,.heic'; f.maxMb = 10; }
    sec.fields.push(f); S.pick = f.key; d.close(); changed(); preview(); inspector();
  });
}

function fieldEditor(box, loc) {
  const f = loc.field;
  $('#insp-title').textContent = f.label || f.key;
  const core = K.coreKeysFor(S.draft).includes(f.key);
  const fromJf = f.qid && !String(f.qid).startsWith('x');
  const others = K.allFields(S.draft).map((x) => x.field).filter((x) => x.key !== f.key && K.isInput(x));
  const hub = S.hub;
  box.innerHTML = `
    <div class="field"><label>Question</label><input id="fL" value="${esc(f.label || '')}"></div>
    ${f.type === 'html' ? `<div class="field"><label>Text (bold, links, lists allowed)</label><textarea id="fH" rows="6">${esc(f.html || '')}</textarea></div>` : `
    <div class="field"><label>Help text</label><input id="fHelp" value="${esc(f.help || '')}"></div>
    <div class="row2"><div class="field"><label>Type</label><select id="fT" ${core ? 'disabled' : ''}>${Object.entries(K.FIELD_TYPES).map(([k, v]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Width</label><select id="fW"><option value="">Full</option><option value="half"${f.width === 'half' ? ' selected' : ''}>Half</option></select></div></div>
    ${K.FIELD_TYPES[f.type]?.options ? `<div class="field"><label>Options (one per line)</label><textarea id="fO" rows="5">${esc((f.options || []).join('\n'))}</textarea>${fromJf ? '<span class="help">Keep these the same as Jotform\'s, or the portals may not match the answer.</span>' : ''}</div>` : ''}
    <label class="check"><input type="checkbox" id="fR"${f.required ? ' checked' : ''}${f.type === 'hidden' ? ' disabled' : ''}><span>Required</span></label>
    ${f.type === 'fullname' ? `<label class="check"><input type="checkbox" id="fM"${K.asksMiddle(f) ? ' checked' : ''}><span>Ask for middle name(s) (optional for the applicant)</span></label>` : ''}
    <label class="check"><input type="checkbox" id="fS"${f.sensitive ? ' checked' : ''}><span>Sensitive (medical / passport) — blurred in the Applications list until clicked</span></label>`}
    <label class="check"><input type="checkbox" id="fX"${f.hidden ? ' checked' : ''}${core ? ' disabled' : ''}><span>Hide from applicants (past answers are kept)</span></label>
    <details class="adv"${f.showIf?.rules?.length ? ' open' : ''}><summary>Only show when…</summary>
      <div id="rules"></div><div class="row2"><select id="rMatch"><option value="any">any rule matches</option><option value="all"${f.showIf?.match === 'all' ? ' selected' : ''}>all rules match</option></select><button class="btn btn--sm" id="rAdd">+ Add rule</button></div></details>
    ${f.type !== 'html' ? `<details class="adv"${f.hubspot?.contact ? ' open' : ''}><summary>HubSpot</summary>
      <div class="field"><label>Also save the answer to this contact property</label><input id="fHs" list="hsProps" value="${esc(typeof f.hubspot?.contact === 'string' ? f.hubspot.contact : '')}" placeholder="${hub ? 'Start typing a property name' : 'Loading properties…'}">
      <datalist id="hsProps">${(hub?.contactProps || []).map((p) => `<option value="${esc(p.name)}">${esc(p.label)}</option>`).join('')}</datalist>
      <span class="help">Name, email, date of birth and mobile already go to the student's contact; parents' names, emails and phones to theirs.</span></div></details>` : ''}
    <details class="adv"><summary>Details</summary>
      <p class="kv">Key <code>${esc(f.key)}</code> · Jotform field ${fromJf ? `<code>${esc(f.qid)}</code>` : '<em>not in Jotform</em>'}${f.source ? ` · filled from <code>${esc(f.source)}</code>` : ''}${f.prefill ? ` · starts as <code>${esc(f.prefill)}</code>` : ''}</p>
      ${!fromJf && f.type !== 'html' ? `<div class="field"><label>Jotform field ID (after adding the question in Jotform)</label><input id="fQ" value="${String(f.qid || '').startsWith('x') ? '' : esc(f.qid || '')}" placeholder="e.g. 141"></div>` : ''}
    </details>
    <div class="acts"><button class="btn btn--sm" id="mUp">Move up</button><button class="btn btn--sm" id="mDn">Move down</button>
      ${S.draft.steps.length > 1 ? `<select id="mPg" class="btn btn--sm" title="Move to another page"><option value="">Move to page…</option>${S.draft.steps.filter((s) => s.key !== loc.st.key).map((s) => `<option value="${esc(s.key)}">${esc(s.title || s.key)}</option>`).join('')}</select>` : ''}
      ${core ? '' : fromJf ? '' : '<button class="btn btn--sm btn--danger" id="fDel">Delete</button>'}</div>
    ${core ? '<p class="kv">This question is used by the flow, HubSpot or the portals, so it can be reworded but not removed.</p>' : fromJf ? '<p class="kv">From Jotform — hide it rather than delete it, so older answers stay readable.</p>' : ''}`;

  const on = (id, ev, fn) => box.querySelector(id)?.addEventListener(ev, (e) => { fn(e.target); changed(); preview(); });
  on('#fL', 'input', (t) => { f.label = t.value; $('#insp-title').textContent = t.value; });
  on('#fH', 'input', (t) => { f.html = t.value; });
  on('#fHelp', 'input', (t) => { f.help = t.value || undefined; });
  on('#fT', 'change', (t) => { f.type = t.value; if (K.FIELD_TYPES[f.type]?.options && !f.options?.length) f.options = ['Yes', 'No']; fieldEditor(box, loc); });
  on('#fW', 'change', (t) => { f.width = t.value || undefined; });
  on('#fO', 'input', (t) => { f.options = t.value.split('\n').map((s) => s.trim()).filter(Boolean); });
  on('#fR', 'change', (t) => { f.required = t.checked || undefined; });
  on('#fS', 'change', (t) => { f.sensitive = t.checked || undefined; });
  on('#fM', 'change', (t) => { f.middle = t.checked; });
  on('#fX', 'change', (t) => { f.hidden = t.checked || undefined; });
  on('#fHs', 'change', (t) => { const v = t.value.trim(); f.hubspot = v ? { ...(f.hubspot || {}), contact: v } : undefined; });
  on('#fQ', 'change', (t) => { const v = t.value.replace(/\D/g, ''); f.qid = v || f.qid; });
  on('#rMatch', 'change', (t) => { if (f.showIf) f.showIf.match = t.value; });
  box.querySelector('#rAdd').addEventListener('click', () => { f.showIf = f.showIf || { match: 'any', rules: [] }; f.showIf.rules.push({ field: others[0]?.key || '', op: 'equals', value: 'Yes' }); changed(); rules(); preview(); });
  function rules() {
    const rb = box.querySelector('#rules');
    const list = f.showIf?.rules || [];
    rb.innerHTML = list.map((r, i) => `<div class="rule"><select data-r="${i}" data-k="field">${others.map((o) => `<option value="${esc(o.key)}"${o.key === r.field ? ' selected' : ''}>${esc((o.label || o.key).slice(0, 50))}</option>`).join('')}</select>
      <select data-r="${i}" data-k="op">${Object.entries(K.OPS).map(([k, v]) => `<option value="${k}"${k === r.op ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <input data-r="${i}" data-k="value" value="${esc(r.value || '')}"><button class="btn btn--icon btn--sm" data-rdel="${i}" title="Remove">×</button></div>`).join('') || '<p class="kv">Always shown.</p>';
    rb.querySelectorAll('[data-r]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { list[Number(el.dataset.r)][el.dataset.k] = el.value; changed(); preview(); }));
    rb.querySelectorAll('[data-rdel]').forEach((el) => el.addEventListener('click', () => { list.splice(Number(el.dataset.rdel), 1); if (!list.length) delete f.showIf; changed(); rules(); preview(); }));
  }
  rules();
  const move = (dir) => {
    const { sec, i } = locate(f.key);
    const j = i + dir;
    if (j < 0 || j >= sec.fields.length) return;
    [sec.fields[i], sec.fields[j]] = [sec.fields[j], sec.fields[i]]; changed(); preview();
  };
  // Move to another page — keeps the key and Jotform field ID, so answers and portals are unaffected.
  box.querySelector('#mPg')?.addEventListener('change', (ev) => {
    const to = S.draft.steps.find((s) => s.key === ev.target.value);
    if (!to) return;
    const l = locate(f.key);
    if (!to.sections?.length) to.sections = [{ title: '', fields: [] }];
    l.sec.fields.splice(l.i, 1);
    to.sections[to.sections.length - 1].fields.push(f);
    S.step = to.key; changed(); renderFields(); inspector();
    toast(`Moved to “${esc(to.title || to.key)}”.`);
  });
  box.querySelector('#mUp').addEventListener('click', () => move(-1));
  box.querySelector('#mDn').addEventListener('click', () => move(1));
  box.querySelector('#fDel')?.addEventListener('click', () => { if (!confirm('Delete this question?')) return; const l = locate(f.key); l.sec.fields.splice(l.i, 1); S.pick = null; changed(); preview(); inspector(); });
  if (!S.hub) api('GET', { action: 'hubspot' }).then((h) => { S.hub = h; if (S.pick === f.key && S.tab === 'fields') fieldEditor(box, locate(f.key)); }).catch(() => {});
}

// ── tab: permissions packet ─────────────────────────────────────────────────
function renderWaiverTab() {
  const w = S.draft.waiver ? S.draft.waiver : clone(DEFAULT_WAIVER);
  const usingDefault = !S.draft.waiver;
  app.innerHTML = `<div class="page"><div class="cols" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start">
    <div class="panel"><h2>${TEACHER_MODE() ? 'Waiver' : 'Permissions packet'}</h2>${TEACHER_MODE() ? '<p class="sub">Signed by the teacher or trip leader themselves after their application (initials on each part, drawn signature). Stored with the exact wording and sent to HubSpot as a PDF. It starts as the student wording — edit it to suit adults.</p>' : ''}<p class="sub"${TEACHER_MODE() ? ' hidden' : ''}>Signed by a parent or legal guardian in step 3 (on the student's device, or from an emailed link). Each part is initialled; parts marked "under 18 only" are skipped for students who are 18 or over. The signed wording is stored with each signature and sent to HubSpot as a PDF, so editing here never changes what someone already signed.</p>
      ${usingDefault ? '<p class="lint lint--warn">Showing the wording from the Jotform waiver. Edit anything to make it this form\'s own.</p>' : ''}
      <div class="field"><label>Title</label><input id="wT" value="${esc(w.title || '')}"></div>
      <div class="field"><label>Intro (HTML)</label><textarea class="code" id="wI">${esc(w.intro || '')}</textarea></div>
      ${w.parts.map((p, i) => `<div class="sec" style="padding:12px"><div class="field"><label>Part ${i + 1} title</label><input data-p="${i}" data-k="title" value="${esc(p.title)}"></div>
        <div class="field"><label>Who signs this part</label><select data-p="${i}" data-k="appliesTo"><option value="all">Every student</option><option value="under18"${p.appliesTo === 'under18' ? ' selected' : ''}>Students under 18 only</option></select></div>
        <div class="field"><label>Text (HTML: p, strong, u, ul/li, a)</label><textarea class="code" data-p="${i}" data-k="html">${esc(p.html)}</textarea></div>
        ${w.parts.length > 1 ? `<button class="btn btn--sm btn--danger" data-pdel="${i}">Remove this part</button>` : ''}</div>`).join('')}
      <button class="btn btn--sm" id="pAdd">+ Add a part</button>
      <div class="field" style="margin-top:14px"><label>Declaration next to the "I agree" tick</label><textarea id="wD" rows="3">${esc(w.declaration || '')}</textarea></div>
      ${usingDefault ? '' : '<button class="btn btn--sm" id="wReset">Reset to the Jotform wording</button>'}</div>
    <div><div class="seg" style="margin-bottom:10px"${TEACHER_MODE() ? ' hidden' : ''}><button aria-pressed="true" data-age="u18">Preview: under 18</button><button aria-pressed="false" data-age="adult">18 or over</button></div><div class="wvprev" id="wPrev"></div></div></div></div>`;
  let under18 = true;
  const own = () => { if (!S.draft.waiver) S.draft.waiver = w; return S.draft.waiver; };
  const draw = () => renderWaiver($('#wPrev'), S.draft.waiver || w, { under18: TEACHER_MODE() ? false : under18, self: TEACHER_MODE(), onSubmit: async () => {} });
  const bind = (sel, k) => $(sel).addEventListener('input', (e) => { own()[k] = e.target.value; changed(); draw(); });
  bind('#wT', 'title'); bind('#wI', 'intro'); bind('#wD', 'declaration');
  app.querySelectorAll('[data-p]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { own().parts[Number(el.dataset.p)][el.dataset.k] = el.value; changed(); draw(); }));
  app.querySelectorAll('[data-pdel]').forEach((el) => el.addEventListener('click', () => { if (!confirm('Remove this part?')) return; own().parts.splice(Number(el.dataset.pdel), 1); changed(); renderWaiverTab(); }));
  $('#pAdd').addEventListener('click', () => { own().parts.push({ key: `part${Date.now().toString(36)}`, title: 'New part', html: '<p></p>', appliesTo: 'all' }); changed(); renderWaiverTab(); });
  $('#wReset')?.addEventListener('click', () => { if (!confirm('Replace the wording with the original Jotform waiver?')) return; delete S.draft.waiver; changed(); renderWaiverTab(); });
  app.querySelectorAll('[data-age]').forEach((b) => b.addEventListener('click', () => { under18 = b.dataset.age === 'u18'; app.querySelectorAll('[data-age]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
  draw();
}

// ── tab: trips & links ──────────────────────────────────────────────────────
async function renderTrips() {
  app.innerHTML = '<div class="page"><div class="loading">Loading trips…</div></div>';
  const [{ trips }, { programs }] = await Promise.all([api('GET', { action: 'trips' }), S.programs ? { programs: S.programs } : api('GET', { action: 'programs' })]);
  S.trips = trips; S.programs = programs;
  app.innerHTML = `<div class="page"><div class="panel"><h2>Trips &amp; launch links</h2>
    <p class="sub"><strong>Preview</strong> clicks through every step with one-click test answers and saves nothing (it shows the published form — Publish first to see edits). <strong>Test run</strong> is a real application with a "Fill test answers" button — you type only the student and parent emails; refund the deposit and mark it withdrawn afterwards.</p>
    <p class="sub">Each school trip gets its own link — put it on that school's launch page. The link decides the trip, so students never pick a program. Deposit and currency come from the trip's payment schedule in HubSpot (payment amount 1, program currency) unless you set them here.</p>
    <div class="acts"><button class="btn btn--primary btn--sm" id="tAdd">+ New trip link</button></div>
    ${trips.length ? `<table class="grid"><tr><th>Link</th><th>Unearthed Program</th><th>Deposit</th><th>Applications</th><th>Status</th><th></th></tr>
      ${trips.map((t) => {
        const p = programs.find((x) => x.id === t.program_id);
        const dep = t.deposit ?? p?.deposit; const cur = t.currency || p?.currency || 'NZD';
        return `<tr><td><div class="linkbox"><code>${esc(APPLY_SITE.replace('https://', ''))}/${esc(t.slug)}</code><button class="btn btn--sm" data-copy="${esc(t.slug)}">Copy</button>
            <a class="btn btn--sm" target="_blank" rel="noopener" href="${APPLY_SITE}/${esc(t.slug)}?preview=1" title="Click through every step with test answers — nothing is saved or sent">Preview ↗</a>
            <a class="btn btn--sm" target="_blank" rel="noopener" href="${APPLY_SITE}/${esc(t.slug)}?test=1" title="A REAL application (HubSpot, Jotform, emails, Stripe) with a Fill test answers button">Test run ↗</a></div>
            <div class="linkbox em" style="margin-top:4px">Teachers <button class="btn btn--sm" data-copy="${esc(t.slug)}/teacher">Copy</button> · Trip leaders <button class="btn btn--sm" data-copy="${esc(t.slug)}/leader">Copy</button>
            <a class="btn btn--sm" target="_blank" rel="noopener" href="${APPLY_SITE}/${esc(t.slug)}/teacher?preview=1" title="The teacher &amp; trip leader form — nothing is saved or sent">Preview ↗</a>
            <a class="btn btn--sm" target="_blank" rel="noopener" href="${APPLY_SITE}/${esc(t.slug)}/teacher?test=1" title="A REAL teacher application (HubSpot contact, emails) with Fill test answers">Test run ↗</a></div></td>
          <td>${esc(t.program_name || p?.name || t.program_id)}${p?.schoolCollecting ? ' <span class="chip chip--warn">school collects payments</span>' : ''}</td>
          <td>${dep ? `${esc(cur)} ${esc(dep)}${t.deposit != null ? ' <span class="em">(set here)</span>' : ''}` : '<span class="chip chip--bad">not set</span>'}</td>
          <td>${t.applications}${t.staff ? ` (+${t.staff} staff)` : ''} · ${t.paid} paid${t.capacity ? ` / ${t.capacity}` : ''}</td>
          <td>${t.open ? (t.closes_on ? `Open until ${esc(String(t.closes_on).slice(0, 10))}` : '<span class="chip chip--live">Open</span>') : '<span class="chip chip--draft">Closed</span>'}</td>
          <td><button class="btn btn--sm" data-edit="${esc(t.slug)}">Edit</button></td></tr>`;
      }).join('')}</table>` : '<div class="empty">No trip links yet.</div>'}</div></div>`;
  app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { navigator.clipboard?.writeText(`${APPLY_SITE}/${b.dataset.copy}`); toast('Link copied'); }));
  app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => tripDialog(trips.find((t) => t.slug === b.dataset.edit))));
  $('#tAdd').addEventListener('click', () => tripDialog(null));
}

const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
function tripDialog(t) {
  const isNew = !t;
  t = t ? { ...t } : { slug: '', program_id: '', open: true };
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">${isNew ? 'New trip link' : 'Edit trip link'}</h2><button class="btn btn--sm" data-x>Cancel</button></div><div class="dlg-body">
    <div class="field"><label>Unearthed Program (HubSpot)</label><select id="tP"><option value="">Pick the trip…</option>${S.programs.map((p) => `<option value="${p.id}"${p.id === t.program_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Link name</label><input id="tS" value="${esc(t.slug)}"${!isNew && t.applications ? ' disabled' : ''}><span class="help">${esc(APPLY_SITE)}/<strong id="tSprev">${esc(t.slug)}</strong>${!isNew && t.applications ? ' — can\'t change once there are applications.' : ''}</span></div>
    <div class="row2"><div class="field"><label>School (shown to applicants)</label><input id="tSc" value="${esc(t.school || '')}"></div><div class="field"><label>Destination (deal name: "Student — Destination")</label><input id="tD" value="${esc(t.destination || '')}"></div></div>
    <div class="row2"><div class="field"><label>Deposit override</label><input id="tDep" type="number" step="0.01" value="${esc(t.deposit ?? '')}" placeholder="from the payment schedule"></div><div class="field"><label>Currency override</label><input id="tCur" value="${esc(t.currency || '')}" placeholder="from the program"></div></div>
    <div class="row2"><div class="field"><label>Close automatically after</label><input id="tClose" type="date" value="${esc(t.closes_on ? String(t.closes_on).slice(0, 10) : '')}"></div><div class="field"><label>Places (closes when this many have paid)</label><input id="tCap" type="number" value="${esc(t.capacity ?? '')}"></div></div>
    <label class="check"><input type="checkbox" id="tO"${t.open ? ' checked' : ''}><span>Open for applications</span></label>
    <div class="field"><label>Note (staff only)</label><input id="tN" value="${esc(t.note || '')}"></div>
    <p class="lint lint--error hidden" id="tErr"></p>
    <div class="acts"><button class="btn btn--primary" id="tSave">Save</button>${!isNew && !t.applications ? '<button class="btn btn--danger btn--sm" id="tDel">Delete link</button>' : ''}</div></div>`);
  const sel = d.querySelector('#tP');
  sel.addEventListener('change', () => {
    const p = S.programs.find((x) => x.id === sel.value); if (!p) return;
    const m = /^(.*?)\s+[-–—]\s+(.+)$/.exec(p.name);
    if (isNew || !d.querySelector('#tS').value) { d.querySelector('#tS').value = slugify(p.name); d.querySelector('#tSprev').textContent = slugify(p.name); }
    if (!d.querySelector('#tSc').value && m) d.querySelector('#tSc').value = m[1];
    if (!d.querySelector('#tD').value && m) d.querySelector('#tD').value = m[2];
  });
  d.querySelector('#tS').addEventListener('input', (e) => { e.target.value = slugify(e.target.value); d.querySelector('#tSprev').textContent = e.target.value; });
  d.querySelector('#tSave').addEventListener('click', async () => {
    const p = S.programs.find((x) => x.id === sel.value);
    try {
      await api('POST', {}, { action: 'trip-save', trip: { originalSlug: isNew ? '' : t.slug, slug: d.querySelector('#tS').value, program_id: sel.value, program_name: p?.name, school: d.querySelector('#tSc').value, destination: d.querySelector('#tD').value, deposit: d.querySelector('#tDep').value, currency: d.querySelector('#tCur').value, closes_on: d.querySelector('#tClose').value, capacity: d.querySelector('#tCap').value, open: d.querySelector('#tO').checked, note: d.querySelector('#tN').value } });
      d.close(); toast('Saved'); renderTrips();
    } catch (e) { const el = d.querySelector('#tErr'); el.textContent = e.message; el.classList.remove('hidden'); }
  });
  d.querySelector('#tDel')?.addEventListener('click', async () => { if (!confirm('Delete this link?')) return; await api('POST', {}, { action: 'trip-delete', slug: t.slug }); d.close(); renderTrips(); });
}

// ── tab: wording & emails ───────────────────────────────────────────────────
const TEXTS = [
  ['aboutIntro', 'About you — intro', 'Apply for {trip}. It takes about 20 minutes…'],
  ['applicationIntro', 'Application — intro', 'Your answers save as you go…'],
  ['waiverIntro', 'Permissions packet — intro', 'A parent or legal guardian needs to read and sign this…'],
  ['depositIntro', 'Deposit — intro', 'Your deposit confirms your place…'],
  ['doneNext', 'Done — next steps', 'Next: log in to your Unearthed portal…'],
];
const EMAILS = [['resume', 'Continue-your-application link'], ['submitted', 'Application received (student, parents copied)'], ['signRequest', 'Parent signing request'], ['signed', 'Signed copy to the parent'], ['deposit', 'Deposit received'], ['paymentFailed', 'Payment failed (deposits and portal payments)']];
const TEACHER_EMAILS = [['resume', 'Continue-your-application link'], ['submitted', 'Application received'], ['signed', 'Signed waiver copy']];
function renderSettings() {
  const st = S.draft.settings = S.draft.settings || {};
  st.texts = st.texts || {}; st.emails = st.emails || {}; st.jotform = st.jotform || {};
  app.innerHTML = `<div class="page">
    <div class="panel"><h2>Payment &amp; Jotform</h2><div class="cols">
      <div class="field"><label>Card fee (%)</label><input id="cfr" type="number" step="0.1" value="${esc(((st.cardFeeRate ?? 0.03) * 100).toFixed(1))}"><span class="help">Added to card deposits, not credited to the deal. Same as the portal's 3% by default.</span></div>
      <div class="field"><label>Jotform form the portals read</label><input id="jfid" value="${esc(st.jotform.formId || '')}"><span class="help">Every application is also saved here (same field IDs), so both portals and leader edits keep working.</span></div></div></div>
    <div class="panel"><h2>Wording on each step</h2><p class="sub">Leave blank to use the default.</p>${TEXTS.map(([k, l, ph]) => `<div class="field"><label>${esc(l)}</label><textarea rows="2" data-text="${k}" placeholder="${esc(ph)}">${esc(st.texts[k] || '')}</textarea></div>`).join('')}</div>
    <div class="panel"><h2>Emails</h2><p class="sub">Placeholders: ${TEACHER_MODE() ? '{{student}} {{studentFirst}} (the applicant) {{role}} {{trip}} {{school}} {{link}}' : '{{student}} {{studentFirst}} {{parent}} {{trip}} {{school}} {{link}} {{amount}} — payment failed also has {{reason}} {{what}}'}. Blank = the default shown.</p>
      ${(TEACHER_MODE() ? TEACHER_EMAILS : EMAILS).map(([k, l]) => `<details class="adv"><summary>${esc(l)}</summary><div class="field"><label>Subject</label><input data-email="${k}" data-part="subject" value="${esc(st.emails[k]?.subject || '')}" placeholder="${esc(defaultEmail(k, S.formKind).subject)}"></div>
        <div class="field"><label>Message</label><textarea rows="7" data-email="${k}" data-part="body" placeholder="${esc(defaultEmail(k, S.formKind).body)}">${esc(st.emails[k]?.body || '')}</textarea></div></details>`).join('')}</div></div>`;
  $('#cfr').addEventListener('input', (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v < 20) { st.cardFeeRate = Math.round(v * 10) / 1000; changed(); } });
  $('#jfid').addEventListener('input', (e) => { st.jotform.formId = e.target.value.replace(/\D/g, ''); changed(); });
  app.querySelectorAll('[data-text]').forEach((el) => el.addEventListener('input', () => { if (el.value.trim()) st.texts[el.dataset.text] = el.value; else delete st.texts[el.dataset.text]; changed(); }));
  app.querySelectorAll('[data-email]').forEach((el) => el.addEventListener('input', () => { const e = st.emails[el.dataset.email] = st.emails[el.dataset.email] || {}; if (el.value.trim()) e[el.dataset.part] = el.value; else delete e[el.dataset.part]; changed(); }));
}

// ── tab: applications ───────────────────────────────────────────────────────
const STATUS = { started: 'Started', applied: 'Applied', signed: 'Signed', paid: 'Deposit paid', imported: 'From Jotform', withdrawn: 'Withdrawn' };
async function renderApps() {
  app.innerHTML = '<div class="page"><div class="loading">Loading applications…</div></div>';
  if (!S.trips) S.trips = (await api('GET', { action: 'trips' })).trips;
  const f = S.appFilter;
  const { applications, counts } = await api('GET', { action: 'applications', ...(f.trip ? { trip: f.trip } : {}), ...(f.status ? { status: f.status } : {}), ...(f.q ? { q: f.q } : {}), ...(f.kind ? { kind: f.kind } : {}) });
  S.apps = applications;
  const total = Object.entries(counts).filter(([k]) => k !== 'withdrawn').reduce((a, [, n]) => a + n, 0);
  app.innerHTML = `<div class="page">
    <div class="filters"><select id="fTrip" class="inp" style="max-width:280px"><option value="">All trips</option>${S.trips.map((t) => `<option value="${esc(t.slug)}"${t.slug === f.trip ? ' selected' : ''}>${esc(t.program_name || t.slug)}</option>`).join('')}</select>
      ${[['', `All (${total})`], ['attention', 'Needs attention'], ['started', `Started (${counts.started || 0})`], ['applied', `Applied (${counts.applied || 0})`], ['signed', `Signed (${counts.signed || 0})`], ['paid', `Deposit paid (${counts.paid || 0})`], ['imported', `From Jotform (${counts.imported || 0})`], ['withdrawn', `Withdrawn (${counts.withdrawn || 0})`]].map(([k, l]) => `<button class="chipbtn" data-st="${k}" aria-pressed="${f.status === k}">${l}</button>`).join('')}
      <span class="seg">${[['', 'Everyone'], ['student', 'Students'], ['teacher', 'Teachers & leaders']].map(([k, l]) => `<button data-kind-f="${k}" aria-pressed="${f.kind === k}">${l}</button>`).join('')}</span>
      <input id="fQ" class="inp" style="max-width:220px" type="search" placeholder="Search name or email" value="${esc(f.q)}">
      <span class="spacer" style="flex:1"></span><button class="btn btn--sm" id="addHs">Add from HubSpot</button></div>
    ${applications.length ? `<table class="grid apps"><tr><th>Applicant</th><th>Trip</th><th>Progress</th><th>Permissions</th><th>Deposit</th><th>Updated</th></tr>
      ${applications.map((a) => `<tr data-id="${a.id}"><td><div class="nm">${esc([a.first_name, a.last_name].filter(Boolean).join(' ') || a.email)}${a.kind === 'teacher' ? ` <span class="chip ${a.approved ? 'chip--live' : a.step2_at ? 'chip--warn' : 'chip--info'}" title="${a.approved ? 'Approved — on the trip in the leader portal' : 'Not approved yet — no leader-portal access'}">${esc(a.role || 'Teacher')}${a.approved ? '' : a.step2_at ? ' · to approve' : ''}</span>` : ''}</div><div class="em">${esc(a.email)}</div></td>
        <td>${esc(a.program_name || a.trip_slug || '')}</td>
        <td><span class="chip ${a.status === 'paid' ? 'chip--live' : a.status === 'withdrawn' ? 'chip--draft' : 'chip--info'}">${esc(STATUS[a.status] || a.status)}</span>${a.sync_errors ? ' <span class="chip chip--bad" title="A HubSpot or Jotform step failed">sync</span>' : ''}</td>
        <td>${a.waiver_status === 'signed' ? '<span class="chip chip--live">Signed</span>' : a.waiver_status === 'sent' ? `<span class="chip chip--warn" title="${esc(a.waiver_sent_to || '')}">Sent to parent</span>` : '—'}</td>
        <td>${a.kind === 'teacher' ? '<span class="em">n/a</span>' : a.deposit_status === 'paid' ? `${esc(a.deposit_currency || '')} ${esc(a.deposit_amount || '')}` : a.deposit_status ? esc(a.deposit_status) : '—'}</td>
        <td class="em">${when(a.updated_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No applications here yet.</div>'}</div>`;
  $('#fTrip').addEventListener('change', (e) => { f.trip = e.target.value; render(); });
  app.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => { f.status = b.dataset.st; renderApps(); }));
  app.querySelectorAll('[data-kind-f]').forEach((b) => b.addEventListener('click', () => { f.kind = b.dataset.kindF; renderApps(); }));
  let t; $('#fQ').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); renderApps(); }, 350); });
  app.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => showApp(tr.dataset.id)));
  $('#addHs').addEventListener('click', addFromHubspot);
  const deep = /#app=([0-9a-f-]{36})/.exec(location.hash); if (deep) { history.replaceState(null, '', location.pathname); showApp(deep[1]); }
}

function addFromHubspot() {
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Add a student from HubSpot</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    <p>For students who applied on the old Jotform form. Finds their HubSpot contact, their Unearthed Education deal and their Jotform application, and adds them to this list — nothing is created or changed in HubSpot or Jotform.</p>
    <div class="row2"><div class="field"><label>Student's email</label><input id="hE" type="email"></div><div class="field" style="justify-content:flex-end"><button class="btn" id="hFind">Find</button></div></div>
    <div id="hOut"></div></div>`);
  d.querySelector('#hFind').addEventListener('click', async () => {
    const out = d.querySelector('#hOut'); out.innerHTML = '<p class="muted">Looking…</p>';
    try {
      const r = await api('POST', {}, { action: 'lookup', email: d.querySelector('#hE').value });
      if (r.existing) { out.innerHTML = `<p class="lint lint--warn">Already in the list (${esc(STATUS[r.existing.status] || r.existing.status)}).</p>`; return; }
      if (!r.contact) { out.innerHTML = '<p class="lint lint--error">No HubSpot contact has that email.</p>'; return; }
      const tripOpts = S.trips.map((t) => `<option value="${esc(t.slug)}"${r.programs.some((p) => p.slug === t.slug) ? ' selected' : ''}>${esc(t.program_name || t.slug)}</option>`).join('');
      out.innerHTML = `<dl class="ans"><dt>Contact</dt><dd><a href="${HS}/0-1/${r.contact.id}" target="_blank" rel="noopener">${esc(r.contact.name || r.email)}</a></dd>
        <dt>Deal</dt><dd>${r.deals.length ? `<select id="hD">${r.deals.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>` : '<span class="em">none in Unearthed Education</span>'}</dd>
        <dt>On program(s)</dt><dd>${r.programs.map((p) => esc(p.name || p.id)).join(', ') || '<span class="em">none</span>'}</dd>
        <dt>Jotform application</dt><dd>${r.jotform?.id ? `#${esc(r.jotform.id)} (${esc(r.jotform.createdAt || '')})` : r.jotform?.error ? esc(r.jotform.error) : '<span class="em">not found</span>'}</dd></dl>
        <div class="field"><label>Trip</label><select id="hT">${tripOpts}</select><span class="help">Only trips with a link on the Trips tab are listed.</span></div>
        <div class="acts"><button class="btn btn--primary" id="hGo">Add to Applications</button></div>`;
      d.querySelector('#hGo').addEventListener('click', async () => {
        try {
          await api('POST', {}, { action: 'import', email: r.email, slug: d.querySelector('#hT').value, dealId: d.querySelector('#hD')?.value });
          d.close(); toast('Added'); renderApps();
        } catch (e) { out.insertAdjacentHTML('beforeend', `<p class="lint lint--error">${esc(e.message)}</p>`); }
      });
    } catch (e) { out.innerHTML = `<p class="lint lint--error">${esc(e.message)}</p>`; }
  });
}

async function showApp(id) {
  const { app: a, files, error } = await api('GET', { action: 'application', id });
  if (error) { toast(esc(error)); return; }
  const teacher = a.kind === 'teacher';
  // The answers are laid out by the form they applied on.
  const kind = teacher ? 'teacher' : 'student';
  if (!S.schemas[kind]) {
    if (S.formKind === kind && S.draft) S.schemas[kind] = S.draft;
    else { try { const r = await fetch(`${API}?action=get${teacher ? '&form=teacher' : ''}`, { credentials: 'include' }).then((x) => x.json()); S.schemas[kind] = r.form?.draft || {}; } catch { S.schemas[kind] = {}; } }
  }
  const schema = S.schemas[kind] || {};
  const role = a.role || 'Teacher';
  const fileLink = (fid, name) => `<a href="${API}?action=file&id=${encodeURIComponent(fid)}" target="_blank" rel="noopener">${esc(name)}</a>`;
  const val = (f, v) => {
    if (f.type === 'file') return (Array.isArray(v) ? v : []).map((x) => (x.id ? fileLink(x.id, x.name) : x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a> <span class="em">(Jotform)</span>` : esc(x.name))).join(', ');
    const t = esc(K.valueText(f, v));
    return f.sensitive ? `<span class="sens" title="Click to show">${t}</span>` : t;
  };
  const answers = (schema.steps || []).flatMap((st) => st.sections.map((sec) => {
    const rows = sec.fields.filter((f) => K.isInput(f) && f.type !== 'hidden' && a.answers?.[f.key] != null && !K.isEmptyValue(f, a.answers[f.key]));
    return rows.length ? `<h3>${esc(sec.title || st.title || '')}</h3>${rows.map((f) => `<dt>${esc(f.label)}</dt><dd>${val(f, a.answers[f.key])}</dd>`).join('')}` : '';
  })).join('');
  const sync = a.sync || {};
  const syncRow = (k, label, retry = true) => sync[k] ? `<li>${sync[k].ok ? '✅' : '⚠️'} ${label}${sync[k].ok ? '' : ` — <span class="em">${esc(sync[k].error || '')}</span>${retry ? ` <button class="btn btn--sm" data-retry="${k}">Retry</button>` : ''}`}</li>` : '';
  const w = a.waiver || {};
  const nm = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email;
  const d = openDialog(`<div class="dlg-head"><div><h2 class="serif">${esc(nm)}</h2><div class="em">${esc(a.email)} · ${esc(a.program_name || '')}</div></div><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    <p>${teacher ? `<span class="chip chip--info">${esc(role)}</span> ` : ''}<span class="chip chip--info">${esc(STATUS[a.status] || a.status)}</span> ${a.imported ? `<span class="chip chip--draft">Added from HubSpot${a.imported.by ? ` by ${esc(a.imported.by)}` : ''}</span>` : ''}</p>
    <dl class="ans"><dt>Started</dt><dd>${when(a.step1_at) || '—'}</dd><dt>Application</dt><dd>${when(a.step2_at) || 'not submitted'}</dd>
      ${teacher ? `<dt>Leader portal</dt><dd>${a.approval ? `Approved as ${esc(a.approval.label)}${a.approval.by ? ` by ${esc(a.approval.by)}` : ''} ${when(a.approval.at)}` : a.step2_at ? `<span class="chip chip--warn">Not approved</span> <select id="apRole" class="inp" style="max-width:150px;display:inline-block"><option${role === 'Teacher' ? ' selected' : ''}>Teacher</option><option${role === 'Trip Leader' ? ' selected' : ''}>Trip Leader</option></select> <button class="btn btn--sm btn--primary" id="approve">Approve</button><div class="em">Approving adds them to the trip in HubSpot with this label — that's what opens the leader portal (rosters, medical and passport details).</div>` : '—'}</dd>` : ''}
      <dt>${teacher ? 'Waiver' : 'Permissions packet'}</dt><dd>${w.status === 'signed' ? `Signed by ${esc(w.parentName)}${teacher ? '' : ` (${esc(w.relationship)})`} ${when(w.signedAt)} · <a href="${API}?action=waiver-pdf&id=${a.id}" target="_blank" rel="noopener">PDF</a>` : w.status === 'sent' ? `Sent to ${esc(w.sentTo)} ${when(w.sentAt)} · <button class="btn btn--sm" id="reW">Send again</button>` : a.step2_at && !teacher ? '<button class="btn btn--sm" id="reW">Email the signing link to the parent</button>' : teacher && a.step2_at ? 'Not signed yet — they sign from their own link' : '—'}</dd>
      <dt>Deposit</dt><dd>${a.deposit ? `${esc(a.deposit.status)} — ${esc(a.deposit.currency || '')} ${esc(a.deposit.amount || '')} by ${esc(a.deposit.method || '')}${a.deposit.paidAt ? `, ${when(a.deposit.paidAt)}` : ''}` : '—'}</dd>
      <dt>HubSpot</dt><dd>${a.hubspot_contact_id ? `<a href="${HS}/0-1/${a.hubspot_contact_id}" target="_blank" rel="noopener">Contact</a>` : 'no contact'}${a.hubspot_deal_id ? ` · <a href="${HS}/0-3/${a.hubspot_deal_id}" target="_blank" rel="noopener">Deal</a>` : ''}</dd>
      <dt>Jotform</dt><dd>${a.jotform_submission_id ? `<a href="https://www.jotform.com/submission/${esc(a.jotform_submission_id)}" target="_blank" rel="noopener">#${esc(a.jotform_submission_id)}</a>` : '—'}</dd></dl>
    ${Object.keys(sync).length ? `<ul class="sync">${syncRow('contact', 'Student contact')}${syncRow('parents', 'Parent contacts')}${syncRow('deal', 'Deal')}${syncRow('program', 'Linked to the program')}${syncRow('jotform', 'Saved to Jotform (portals)')}${syncRow('waiverPdf', 'Permissions PDF on HubSpot')}${syncRow('signRequest', 'Signing email')}${syncRow('confirmation', `Confirmation email${sync.confirmation?.cc?.length ? ` (parents copied: ${esc(sync.confirmation.cc.join(', '))})` : ''}`, false)}</ul>` : ''}
    <div class="acts">${a.status !== 'imported' && a.step2_at ? '<button class="btn btn--sm" id="reAll">Retry all syncs</button>' : ''}${a.status !== 'withdrawn' ? '<button class="btn btn--sm btn--danger" id="wd">Mark withdrawn</button>' : ''}</div>
    ${files.length ? `<h3>Uploads</h3><p>${files.map((x) => fileLink(x.id, x.name)).join(' · ')}</p>` : ''}
    <dl class="ans">${answers || '<dd class="em">No answers yet.</dd>'}</dl></div>`);
  d.querySelectorAll('.sens').forEach((el) => el.addEventListener('click', () => el.classList.remove('sens'), { once: true }));
  const resync = async (only) => { try { const r = await api('POST', {}, { action: 'resync', id: a.id, only }); toast(Object.entries(r.result || {}).map(([k, v]) => `${k}: ${v.ok ? 'ok' : esc(v.error)}`).join(' · ') || 'Done', 6000); d.close(); showApp(a.id); } catch (e) { toast(esc(e.message)); } };
  d.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => resync([b.dataset.retry])));
  d.querySelector('#reAll')?.addEventListener('click', () => resync(null));
  d.querySelector('#approve')?.addEventListener('click', async (e) => {
    const asRole = d.querySelector('#apRole').value;
    if (!confirm(`Approve ${nm} as ${asRole}? They'll get access to this trip in the leader portal — including students' medical and passport details.`)) return;
    e.target.disabled = true;
    try { await api('POST', {}, { action: 'approve-teacher', id: a.id, role: asRole }); toast(`Approved as ${esc(asRole)}`); d.close(); showApp(a.id); renderApps(); }
    catch (err) { toast(esc(err.message), 8000); e.target.disabled = false; }
  });
  d.querySelector('#reW')?.addEventListener('click', async () => {
    const email = prompt('Send the signing link to:', w.sentTo || a.answers?.parent1Email || '');
    if (!email) return;
    try { const r = await api('POST', {}, { action: 'send-waiver', id: a.id, email }); toast(r.emailed ? `Sent to ${esc(r.to)}` : 'Saved, but the email could not be sent (check SMTP on the ue-apply site).'); d.close(); showApp(a.id); } catch (e) { toast(esc(e.message)); }
  });
  d.querySelector('#wd')?.addEventListener('click', async () => {
    if (!confirm('Mark this application withdrawn? Their link stops working. HubSpot and Jotform are not changed — update the deal yourself if needed.')) return;
    await api('POST', {}, { action: 'withdraw', id: a.id }); d.close(); renderApps();
  });
}

// ── boot ────────────────────────────────────────────────────────────────────
async function load() {
  const r = await api('GET', { action: 'get' });
  if (r.form?.draft) S.schemas[S.formKind] = r.form.draft;
  S.form = r.form; S.draft = r.form?.draft ? clone(r.form.draft) : null; S.lint = r.lint || [];
  chrome(); render();
  // Older drafts gave every added question the same ID (x10000) — renumber and save.
  if (S.draft && K.repairSyntheticQids(S.draft)) { changed(); toast('Fixed duplicate field IDs on added questions — saved.'); }
}
if (/#app=/.test(location.hash)) S.tab = 'apps';
load().catch((e) => { app.innerHTML = `<div class="page"><p class="lint lint--error">${esc(e.message)}</p></div>`; });
