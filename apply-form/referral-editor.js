// apply-form/referral-editor.js — editor for the referral form (pd-apply /refer).
//
// The form is one JSON document stored in apply_forms as 'pd-referral' (see
// referral-kit.mjs for its shape). Changes autosave as a draft; visitors only
// see them after Publish. Each referral lands in the `referrals` table
// (MIGRATION-referral.sql) and creates/links two HubSpot contacts.

import { esc } from '/apply-form/form-kit.mjs';
import { lintReferral, CORE_FIELDS, DEFAULT_ASSOCIATION_LABEL } from '/apply-form/referral-kit.mjs';
import { classify } from '/apply-form/attribution-kit.mjs';

const API = '/api/apply-forms';
const SAVE_DELAY = 1200;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const S = { user: null, form: null, draft: null, rev: 0, lint: [], applySite: null, tab: 'form', open: new Set(), hubspot: null,
  saveTimer: null, saving: false, dirty: false, saveError: null, refs: { q: '', type: '', list: [] } };

const PAGES = [['referrer', 'About the person referring', 'Their own HubSpot contact is created or updated (with their real Original Source).'],
  ['friend', 'Who they’re referring', 'Becomes a new lead in HubSpot, linked to the referrer as “Referred by”.']];
const TYPES = [['text', 'Short text'], ['textarea', 'Long text'], ['email', 'Email'], ['phone', 'Phone'], ['date', 'Date'], ['select', 'Dropdown (pick one)'], ['radio', 'Pick one'], ['checkbox', 'Pick several']];
const CHOICE = ['radio', 'select', 'checkbox'];

async function api(method, params = {}, body) {
  const qs = new URLSearchParams({ form: 'referral', ...params }).toString();
  const res = await fetch(`${API}?${qs}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify({ form: 'referral', ...body }) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) notice('bad', 'Your sign-in has expired. <a href="/" target="_blank" rel="noopener">Sign in again in a new tab</a>, then come back — your changes are kept here.');
  if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; e.body = data; throw e; }
  return data;
}
function toast(html, ms = 4000) {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.innerHTML = html;
  document.body.appendChild(el); setTimeout(() => el.remove(), ms);
}
function notice(kind, html) { $('#notices').innerHTML = html ? `<div class="notice notice--${kind}">${html}</div>` : ''; }
function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; d.showModal(); return d; }
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
    const d = openDialog(`<div class="dlg-head"><h2 class="serif">${esc(title)}</h2></div><div class="dlg-body"><p>${esc(body)}</p><div class="field"><input type="text" id="pd-in" placeholder="${esc(placeholder || '')}"></div><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn btn--primary" data-ok>Publish</button></div></div>`);
    let done = false;
    d.querySelector('[data-x]').onclick = () => { done = true; d.close(); resolve(null); };
    d.querySelector('[data-ok]').onclick = () => { done = true; const v = $('#pd-in').value; d.close(); resolve(v); };
    d.onclose = () => { if (!done) resolve(null); };
  });
}

// ── save / publish ──────────────────────────────────────────────────────────
function changed({ rerender = false } = {}) {
  S.dirty = true; S.lint = lintReferral(S.draft);
  setSaveState('Unsaved changes');
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, SAVE_DELAY);
  // Deferred: a field blurred by the re-render itself can fire `change` mid-render.
  if (rerender) queueMicrotask(render); else { updateChrome(); renderLint(); }
}
async function save() {
  if (S.saving) { S.saveTimer = setTimeout(save, 400); return; }
  if (!S.dirty) return;
  S.saving = true; S.dirty = false; setSaveState('Saving…');
  try {
    const out = await api('POST', {}, { action: 'save', rev: S.rev, draft: S.draft });
    S.rev = out.rev; S.form.changes = true; S.saveError = null; setSaveState('Saved');
  } catch (err) {
    S.dirty = true; S.saveError = err.message;
    if (err.status === 409) { notice('bad', 'Someone else changed the form. <button class="btn btn--sm" id="reload">Reload their version</button>'); $('#reload')?.addEventListener('click', () => location.reload()); }
    setSaveState(`Not saved — ${err.message}`, true);
  } finally { S.saving = false; updateChrome(); }
}
function setSaveState(t, err = false) { const el = $('#save-state'); el.textContent = t; el.classList.toggle('err', err); }
function updateChrome() {
  const f = S.form;
  $('#status-chip').innerHTML = !f ? '' : !f.publishedRev ? '<span class="chip chip--draft" title="The referral page shows nothing until you publish">Not published yet</span>'
    : (f.changes || S.dirty) ? '<span class="chip chip--changes">Unpublished changes</span>' : '<span class="chip chip--live">Live</span>';
  $('#btn-discard').classList.toggle('hidden', !(f?.publishedRev && f.changes));
  const errs = S.lint.filter((l) => l.level === 'error').length;
  const pub = $('#btn-publish');
  pub.disabled = !S.form || !S.user?.canPublish || errs > 0;
  pub.title = !S.user?.canPublish ? 'Publishing needs an admin or admissions lead.' : errs ? 'Fix the problems listed first.' : 'Make these changes live';
  if (S.applySite) { $('#open-live').href = `${S.applySite}/refer`; $('#open-preview').href = `${S.applySite}/refer?preview=1`; }
  else { $('#open-live').classList.add('hidden'); $('#open-preview').classList.add('hidden'); }
}
async function publish() {
  clearTimeout(S.saveTimer); await save();
  if (S.dirty || S.saveError) { toast('Save failed — fix that first.'); return; }
  const note = await promptDialog('Publish the referral form', 'Visitors see these changes within about 30 seconds. Add a short note (optional).', 'e.g. Added a question for partners');
  if (note === null) return;
  try { await api('POST', {}, { action: 'publish', rev: S.rev, note }); S.form.publishedRev = S.rev; S.form.changes = false; updateChrome(); toast('Published — live within about 30 seconds.'); }
  catch (err) { toast(esc(err.message), 7000); }
}
async function discard() {
  if (!(await confirmDialog('Discard changes?', 'The draft goes back to what visitors currently see.'))) return;
  try { const out = await api('POST', {}, { action: 'discard' }); load(out.form, out.lint); render(); toast('Changes discarded.'); } catch (err) { toast(esc(err.message)); }
}
async function versions() {
  const out = await api('GET', { action: 'versions' });
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">Versions</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">${out.versions.length ? `<table class="grid"><thead><tr><th>When</th><th>What</th><th>Who</th><th></th></tr></thead><tbody>${out.versions.map((v) => `<tr><td>${new Date(v.created_at).toLocaleString()}</td><td>${esc(v.kind)} ${v.note ? `— ${esc(v.note)}` : ''}</td><td>${esc(v.created_by || '')}</td><td><button class="btn btn--sm" data-v="${v.id}">Restore</button></td></tr>`).join('')}</tbody></table>` : '<p>Nothing published yet.</p>'}</div>`);
  d.querySelector('[data-x]').onclick = () => d.close();
  $$('[data-v]', d).forEach((b) => b.onclick = async () => {
    try { const r = await api('POST', {}, { action: 'restore', versionId: b.dataset.v }); d.close(); load(r.form, r.lint); render(); toast('Restored into the draft — publish to make it live.'); } catch (err) { toast(esc(err.message)); }
  });
}

// ── load ────────────────────────────────────────────────────────────────────
function load(form, lint) { S.form = form; S.draft = form ? clone(form.draft) : null; S.rev = form?.draftRev || 0; S.lint = lint || []; }
async function boot() {
  try {
    const out = await api('GET', { action: 'get' });
    S.user = out.user; S.applySite = out.applySite; load(out.form, out.lint);
  } catch (err) { $('#app').innerHTML = `<div class="page"><div class="notice notice--bad">${esc(err.message)}</div></div>`; return; }
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); }));
  $('#btn-publish').onclick = publish; $('#btn-discard').onclick = discard; $('#btn-versions').onclick = versions;
  window.addEventListener('beforeunload', (e) => { if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ''; } });
  render();
}

function render() {
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  updateChrome();
  if (!S.draft && S.tab !== 'referrals') return renderInit();
  if (S.tab === 'form') return renderForm();
  if (S.tab === 'wording') return renderWording();
  if (S.tab === 'hubspot') return renderHubspot();
  return renderReferrals();
}
function renderInit() {
  $('#app').innerHTML = `<div class="page"><div class="panel"><h2 class="serif">Set up the referral form</h2>
    <p class="sub">Starts with two short pages — about the person referring (past or current student, parent, counselor/partner, or staff) and about who they're referring — plus a permission box. Edit anything before you publish; nothing is public until then.</p>
    <button class="btn btn--primary" id="init">Set up the referral form</button></div></div>`;
  $('#init').onclick = async () => {
    try {
      const seed = await (await fetch('/apply-form/referral-seed.json')).json();
      const out = await api('POST', {}, { action: 'init', schema: seed });
      load(out.form, out.lint); render();
    } catch (err) { toast(esc(err.message), 7000); }
  };
}
function renderLint() {
  const el = $('#lint'); if (!el) return;
  const errs = S.lint.filter((l) => l.level === 'error'); const warns = S.lint.filter((l) => l.level !== 'error');
  el.innerHTML = `${errs.length ? `<div class="lint lint--error"><strong>Fix before publishing</strong><ul>${errs.map((l) => `<li>${esc(l.message)}</li>`).join('')}</ul></div>` : ''}${warns.length ? `<div class="lint lint--warn"><strong>Check</strong><ul>${warns.map((l) => `<li>${esc(l.message)}</li>`).join('')}</ul></div>` : ''}`;
}

// ── form ────────────────────────────────────────────────────────────────────
const step = (k) => S.draft.steps.find((s) => s.key === k);
const section = (k) => { const st = step(k); st.sections = st.sections?.length ? st.sections : [{ key: k, fields: [] }]; return st.sections[0]; };
const typeField = () => section('referrer').fields.find((f) => f.key === 'referrerType');
const typeOptions = () => typeField()?.options || [];
const isCore = (f) => !!CORE_FIELDS[f.key];
/** Which "I am…" options a field is limited to (null = everyone). */
function shownFor(f) {
  const rules = f.showIf?.rules || [];
  if (!rules.length || !rules.every((r) => r.field === 'referrerType' && r.op === 'equals')) return null;
  return rules.map((r) => r.value);
}
function setShownFor(f, values) {
  const all = typeOptions();
  if (!values.length || values.length === all.length) delete f.showIf;
  else f.showIf = { match: 'any', rules: values.map((v) => ({ field: 'referrerType', op: 'equals', value: v })) };
}

function renderForm() {
  $('#app').innerHTML = `<div class="page"><div id="lint"></div>
    <div class="panel"><h2 class="serif">How a referral works</h2>
      <div class="flow"><div class="box"><strong>Page 1 · ${esc(PAGES[0][1])}</strong>${esc(PAGES[0][2])}</div><span>→</span><div class="box"><strong>Page 2 · ${esc(PAGES[1][1])}</strong>${esc(PAGES[1][2])}</div></div>
      <p class="sub" style="margin-top:12px">Fields marked <span class="lock">core</span> are what the referral relies on — you can reword them but not remove them. Add your own questions to either page, and limit any of them to particular kinds of referrer (e.g. only ask partners for their organisation).</p></div>
    ${PAGES.map(([k, title]) => {
      const sec = section(k);
      return `<div class="panel" data-page="${k}"><h2 class="serif">${esc(title)}</h2>
        <div class="field" style="max-width:520px"><label>Heading on this page</label><input type="text" data-sectitle value="${esc(sec.title || '')}"></div>
        ${sec.fields.map((f, i) => fieldCard(k, f, i, sec.fields.length)).join('')}
        <div class="acts"><button class="btn" type="button" data-addf>+ Add a question</button></div></div>`;
    }).join('')}</div>`;
  renderLint();
  bindForm();
}

function fieldCard(page, f, i, n) {
  const id = `${page}:${f.key}`;
  const open = S.open.has(id);
  const core = isCore(f);
  const limited = shownFor(f);
  const opts = typeOptions();
  const hsProps = S.hubspot?.contactProps || [];
  const hsVal = typeof f.hubspot?.contact === 'string' ? f.hubspot.contact : '';
  return `<div class="qcard${open ? '' : ' closed'}" data-f="${i}">
    <div class="qcard__head"><span class="n">${i + 1}</span><span class="t" data-toggle>${esc(f.label || '(no question)')}</span>
      ${core ? '<span class="lock">core</span>' : ''}${limited ? `<span class="chip chip--info" title="${esc(limited.join(', '))}">${limited.length === 1 ? esc(limited[0].split(' ').slice(0, 4).join(' ')) + '…' : `${limited.length} referrer types`}</span>` : ''}${f.required ? '<span class="reach">required</span>' : ''}
      <button class="btn btn--icon btn--sm" type="button" data-up title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button class="btn btn--icon btn--sm" type="button" data-down title="Move down"${i === n - 1 ? ' disabled' : ''}>↓</button>
      <button class="btn btn--icon btn--sm btn--danger" type="button" data-del title="${core ? 'Core field — can’t be removed' : 'Delete question'}"${core ? ' disabled' : ''}>✕</button></div>
    <div class="qcard__body">
      <div class="field"><label>Question</label><input type="text" data-k="label" value="${esc(f.label)}"></div>
      <div class="row2"><div class="field"><label>Answer type</label>${core || ['fullname'].includes(f.type)
        ? `<input type="text" disabled value="${esc({ fullname: 'First + last name', radio: 'Pick one', email: 'Email', checkbox: 'Tick box' }[f.type] || f.type)}">`
        : `<select data-k="type">${TYPES.map(([v, l]) => `<option value="${v}"${f.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`}</div>
        <div class="field"><label>Hint under the question</label><input type="text" data-k="help" value="${esc(f.help || '')}"></div></div>
      <label class="check"><input type="checkbox" data-k="required"${f.required ? ' checked' : ''}${core && f.key !== 'consent' ? ' disabled' : ''}><span>Required</span></label>
      ${CHOICE.includes(f.type) ? `<div class="field"><label>${f.key === 'consent' ? 'Text next to the tick box' : 'Answers — one per line'}</label><textarea rows="${Math.min(8, Math.max(2, (f.options || []).length + 1))}" data-opts>${esc((f.options || []).join('\n'))}</textarea>
        ${f.key === 'referrerType' ? '<span class="help">These are the kinds of referrer. Renaming one keeps the questions limited to it.</span>' : ''}</div>` : ''}
      ${!core && opts.length ? `<div class="field"><span class="lbl">Ask this when the referrer is…</span><div class="archs">${opts.map((o) => `<button type="button" data-show="${esc(o)}" aria-pressed="${!limited || limited.includes(o)}">${esc(o)}</button>`).join('')}</div><span class="help">All selected = everyone is asked.</span></div>` : ''}
      ${!core && f.type !== 'fullname' ? `<details class="adv"${hsVal ? ' open' : ''}><summary>HubSpot</summary><div class="field"><label>Also save this answer to a property on ${page === 'referrer' ? 'the referrer’s' : 'the referred person’s'} contact (optional)</label>
        <select data-k="hubspot"><option value="">— only in “PD referral details” —</option>${hsProps.map((p) => `<option value="${esc(p.name)}"${hsVal === p.name ? ' selected' : ''}>${esc(p.label)} (${esc(p.name)})</option>`).join('')}${hsVal && !hsProps.some((p) => p.name === hsVal) ? `<option selected value="${esc(hsVal)}">${esc(hsVal)}</option>` : ''}</select>
        <span class="help">Every answer is always written to the referred person's “PD referral details”.</span></div></details>` : ''}
    </div></div>`;
}

function bindForm() {
  if (!S.hubspot) api('GET', { action: 'hubspot' }).then((h) => { S.hubspot = h; if (S.tab === 'form' && S.open.size) renderForm(); }).catch(() => { S.hubspot = { contactProps: [] }; });
  $$('[data-page]').forEach((panel) => {
    const page = panel.dataset.page; const sec = section(page); const list = sec.fields;
    panel.querySelector('[data-sectitle]').addEventListener('input', (e) => { sec.title = e.target.value; const st = step(page); st.title = e.target.value || st.title; changed(); });
    panel.querySelector('[data-addf]').onclick = () => {
      const used = new Set(S.draft.steps.flatMap((s) => s.sections.flatMap((x) => x.fields.map((f) => f.key))));
      let n = 1; while (used.has(`${page}Q${n}`)) n += 1;
      const key = `${page}Q${n}`;
      list.push({ key, type: 'text', label: 'New question', required: false });
      S.open.add(`${page}:${key}`); changed({ rerender: true });
    };
    $$('[data-f]', panel).forEach((card) => {
      const i = Number(card.dataset.f); const f = list[i]; const id = `${page}:${f.key}`;
      card.querySelector('[data-toggle]').onclick = () => { S.open.has(id) ? S.open.delete(id) : S.open.add(id); card.classList.toggle('closed'); };
      card.querySelector('[data-up]').onclick = () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed({ rerender: true }); } };
      card.querySelector('[data-down]').onclick = () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed({ rerender: true }); } };
      card.querySelector('[data-del]').onclick = async () => { if (!isCore(f) && await confirmDialog('Delete this question?', f.label || '')) { list.splice(i, 1); changed({ rerender: true }); } };
      $$('[data-k]', card).forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
        const k = el.dataset.k;
        if (k === 'required') f.required = el.checked;
        else if (k === 'hubspot') { if (el.value) f.hubspot = { contact: el.value }; else delete f.hubspot; }
        else if (k === 'type') { f.type = el.value; if (CHOICE.includes(f.type)) f.options = f.options?.length ? f.options : ['Option 1', 'Option 2']; else delete f.options; changed({ rerender: true }); return; }
        else if (k === 'help') { if (el.value) f.help = el.value; else delete f.help; }
        else { f[k] = el.value; if (k === 'label') card.querySelector('[data-toggle]').textContent = el.value || '(no question)'; }
        changed();
      }));
      card.querySelector('[data-opts]')?.addEventListener('change', (e) => {
        const old = f.options || [];
        const next = [...new Set(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))];
        if (next.join('\n') === old.join('\n')) return;
        if (!next.length) { e.target.value = old.join('\n'); toast('Keep at least one answer.'); return; }
        f.options = next;
        if (f.key === 'referrerType') renameTypes(old, next);
        changed({ rerender: true });
      });
      $$('[data-show]', card).forEach((b) => b.onclick = () => {
        const cur = new Set(shownFor(f) || typeOptions());
        cur.has(b.dataset.show) ? cur.delete(b.dataset.show) : cur.add(b.dataset.show);
        if (!cur.size) { toast('Pick at least one kind of referrer.'); return; }
        setShownFor(f, typeOptions().filter((o) => cur.has(o)));
        changed({ rerender: true });
      });
    });
  });
}

/** "I am…" options changed: keep conditions pointing at the right option (same position = renamed). */
function renameTypes(old, next) {
  const map = new Map();
  if (old.length === next.length) old.forEach((o, i) => map.set(o, next[i]));
  for (const st of S.draft.steps) for (const sec of st.sections) for (const f of sec.fields) {
    const rules = f.showIf?.rules; if (!rules) continue;
    for (const r of rules) if (r.field === 'referrerType' && map.has(r.value)) r.value = map.get(r.value);
    f.showIf.rules = rules.filter((r) => r.field !== 'referrerType' || next.includes(r.value));
    if (!f.showIf.rules.length) delete f.showIf;
  }
}

// ── wording ─────────────────────────────────────────────────────────────────
function settingInput(st, k, label, help = '', ph = '', area = false) {
  return `<div class="field"><label for="st-${k}">${label}</label>${area
    ? `<textarea id="st-${k}" data-s="${k}" rows="3" placeholder="${esc(ph)}">${esc(st[k] ?? '')}</textarea>`
    : `<input type="text" id="st-${k}" data-s="${k}" value="${esc(st[k] ?? '')}" placeholder="${esc(ph)}">`}${help ? `<span class="help">${help}</span>` : ''}</div>`;
}
function bindSettings(st) {
  $$('[data-s]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const v = el.value.trim(); if (v || el.dataset.s === 'leadStatus') st[el.dataset.s] = v; else delete st[el.dataset.s]; changed();
  }));
}
function renderWording() {
  const st = S.draft.settings = S.draft.settings || {};
  $('#app').innerHTML = `<div class="page"><div id="lint"></div>
    <div class="panel"><h2 class="serif">Wording</h2><div class="cols">
      <div>${settingInput(st, 'introTitle', 'Heading at the top', '', 'Know someone who’d love a gap year?')}${settingInput(st, 'introBody', 'Intro text', 'Plain text; a blank line starts a new paragraph.', '', true)}${settingInput(st, 'submitLabel', 'Submit button', '', 'Send referral')}</div>
      <div>${settingInput(st, 'thanksTitle', 'Thank-you heading', '', 'Thank you!')}${settingInput(st, 'thanksBody', 'Thank-you text', '', '', true)}${settingInput(st, 'anotherLabel', '“Refer someone else” button', 'Starts a new referral with the referrer’s details already filled in. Leave empty to hide it.', 'Refer someone else')}</div>
    </div></div>
    <div class="panel"><h2 class="serif">Sharing the form</h2><p class="sub">Link straight to it from emails and the alumni newsletter. You can prefill who's referring — handy in an email to alumni or partners:</p>
      <div class="kv"><code>${esc(S.applySite || 'https://apply.pacificdiscovery.org')}/refer?type=${encodeURIComponent(typeOptions()[0] || '')}&amp;email=alum@example.com</code></div>
      <p class="sub">Add normal UTM tags (<code>utm_source=newsletter</code> …) to see in Lead Sources where referrers came from.</p></div></div>`;
  renderLint();
  bindSettings(st);
}

// ── hubspot ─────────────────────────────────────────────────────────────────
function renderHubspot() {
  const st = S.draft.settings = S.draft.settings || {};
  const props = S.hubspot?.contactProps || [];
  if (!S.hubspot) api('GET', { action: 'hubspot' }).then((h) => { S.hubspot = h; if (S.tab === 'hubspot') renderHubspot(); }).catch(() => { S.hubspot = { contactProps: [] }; });
  $('#app').innerHTML = `<div class="page"><div id="lint"></div>
    <div class="panel"><h2 class="serif">What happens in HubSpot</h2>
      <ul style="margin:0 0 12px;padding-left:18px;font-size:13px">
        <li><strong>The referrer</strong> is submitted to the HubSpot form below with their visitor cookie, so their Original Source is the real channel. Their “PD referrer type” is set and each referral is added to “PD referrals made”.</li>
        <li><strong>The referred person</strong> is created (or updated) through the API <em>without</em> the cookie — the referrer's browsing isn't pinned on their friend. They get the lead status below, “PD referred by”, “PD referral date” and every answer in “PD referral details”. An existing lead status, owner or lifecycle stage is never overwritten.</li>
        <li>The two contacts are <strong>associated</strong> with the label “${esc(st.associationLabel || DEFAULT_ASSOCIATION_LABEL)}”, so the referrer shows on the referred person's record (and the other way round).</li></ul>
      <button class="btn btn--sm" type="button" id="hs-setup">Set up HubSpot properties &amp; association label</button> <span class="help" id="hs-setup-out"></span></div>
    <div class="panel"><h2 class="serif">Settings</h2><div class="cols"><div>
      <div class="field"><label for="st-hubspotFormGuid">HubSpot form ID (for the referrer)</label><div style="display:flex;gap:8px"><input type="text" id="st-hubspotFormGuid" data-s="hubspotFormGuid" value="${esc(st.hubspotFormGuid || '')}" placeholder="e.g. 1a2b3c4d-5e6f-…"><button class="btn btn--sm" type="button" id="mkform">Create in HubSpot</button></div><span class="help">Turn off HubSpot's own notification emails for this form if you don't want one per referral.</span></div>
      <div class="field"><label for="st-leadStatus">Lead status for the referred person</label><select id="st-leadStatus" data-s="leadStatus">${[['', '— leave as is —'], ['NEW', 'New'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['ATTEMPTED_TO_CONTACT', 'Attempted to contact']].map(([v, l]) => `<option value="${v}"${(st.leadStatus || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      ${settingInput(st, 'associationLabel', 'Association label', 'Must match a contact↔contact label in HubSpot — the setup button creates it.', DEFAULT_ASSOCIATION_LABEL)}</div>
      <div><div class="field"><label for="st-howFoundProperty">Also set this property on the referred person (optional)</label><select id="st-howFoundProperty" data-s="howFoundProperty"><option value="">— none —</option>${props.map((p) => `<option value="${esc(p.name)}"${st.howFoundProperty === p.name ? ' selected' : ''}>${esc(p.label)} (${esc(p.name)})</option>`).join('')}${st.howFoundProperty && !props.some((p) => p.name === st.howFoundProperty) ? `<option selected value="${esc(st.howFoundProperty)}">${esc(st.howFoundProperty)}</option>` : ''}</select><span class="help">e.g. “How did you find us?” = Referral. Use a value that property accepts.</span></div>
      ${settingInput(st, 'howFoundValue', '…to this value', '', 'Referral')}
      ${settingInput(st, 'notifyEmails', 'Email these people about each referral (optional)', 'Comma separated, e.g. admissions@pacificdiscovery.org', '')}</div></div></div></div>`;
  renderLint();
  bindSettings(st);
  $('#mkform').onclick = async (e) => {
    if (st.hubspotFormGuid && !(await confirmDialog('Create another HubSpot form?', 'A form ID is already set. Create a new one and use it instead?', 'Create', false))) return;
    e.target.disabled = true;
    try { const out = await api('POST', {}, { action: 'hubspot-form-create' }); st.hubspotFormGuid = out.id; $('#st-hubspotFormGuid').value = out.id; changed(); toast(`Created “${esc(out.name)}” in HubSpot. Publish to start using it.`, 7000); }
    catch (err) { toast(esc(err.message), 9000); } finally { e.target.disabled = false; }
  };
  $('#hs-setup').onclick = async (e) => {
    e.target.disabled = true; $('#hs-setup-out').textContent = 'Working…';
    try {
      const out = await api('POST', {}, { action: 'referral-hubspot-setup' });
      $('#hs-setup-out').innerHTML = [out.created.length ? `Created: ${esc(out.created.join(', '))}.` : '', out.existing.length ? `Already there: ${esc(out.existing.join(', '))}.` : '', out.failed.length ? `<span style="color:var(--bad)">Failed: ${out.failed.map((f) => esc(`${f.name} (${f.error})`)).join('; ')}</span>` : ''].filter(Boolean).join(' ');
    } catch (err) { $('#hs-setup-out').textContent = err.message; } finally { e.target.disabled = false; }
  };
}

// ── referrals ───────────────────────────────────────────────────────────────
const full = (f, l) => `${f || ''} ${l || ''}`.trim() || '—';
async function renderReferrals() {
  const r = S.refs;
  const types = S.draft ? typeOptions() : [];
  $('#app').innerHTML = `<div class="page"><div class="filters"><button class="chipbtn" data-type="" aria-pressed="${!r.type}">All</button>${types.map((t) => `<button class="chipbtn" data-type="${esc(t)}" aria-pressed="${r.type === t}">${esc(t)} <span id="n-${esc(t)}"></span></button>`).join('')}
    <input class="inp" id="q" placeholder="Search either person's name or email" value="${esc(r.q)}" style="max-width:300px;margin-left:auto"></div><div id="body" class="loading">Loading…</div></div>`;
  $$('[data-type]').forEach((b) => b.onclick = () => { r.type = b.dataset.type; renderReferrals(); });
  let qt; $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { r.q = e.target.value; renderReferrals(); }, 400); });
  let out;
  try { out = await api('GET', { action: 'referrals', q: r.q, type: r.type }); } catch (err) { $('#body').innerHTML = `<div class="notice notice--bad">${esc(err.message)}</div>`; return; }
  r.list = out.referrals;
  for (const [t, n] of Object.entries(out.counts || {})) { const el = document.getElementById(`n-${t}`); if (el) el.textContent = `· ${n}`; }
  const body = $('#body'); body.classList.remove('loading');
  if (out.warning) { body.innerHTML = `<div class="notice notice--warn">${esc(out.warning)}</div>`; return; }
  if (!r.list.length) { body.innerHTML = `<div class="panel">${r.q || r.type ? 'No referrals match.' : 'No referrals yet.'}</div>`; return; }
  const hsLink = (id) => (id ? ` <a href="https://app.hubspot.com/contacts/3855728/record/0-1/${esc(id)}" target="_blank" rel="noopener">open ↗</a>` : '');
  const chip = (x) => (x?.ok ? '<span class="chip chip--live">Synced</span>' : x ? `<span class="chip chip--bad" title="${esc(x.error || '')}">Failed</span>` : '<span class="chip chip--draft">Pending</span>');
  body.innerHTML = `<div style="overflow-x:auto"><table class="grid apps"><thead><tr><th>When</th><th>Referred</th><th>Referred by</th><th>Came from</th><th>HubSpot</th><th></th></tr></thead><tbody>
    ${r.list.map((x) => {
      const c = classify(x.attribution?.first || x.attribution || {});
      return `<tr data-id="${x.id}"><td>${new Date(x.created_at).toLocaleString()}</td>
        <td><div class="nm">${esc(full(x.referred_first_name, x.referred_last_name))}</div><div class="em">${esc(x.referred_email)}</div>${x.referred_existed ? '<span class="chip chip--info" title="This email was already in HubSpot">already a contact</span>' : ''}</td>
        <td><div class="nm">${esc(full(x.referrer_first_name, x.referrer_last_name))}</div><div class="em">${esc(x.referrer_email)}</div><div class="em">${esc(x.referrer_type || '')}</div></td>
        <td><span class="chan">${esc(c.channel)}</span><div class="em">${esc([c.source, c.campaign].filter(Boolean).join(' › '))}</div></td>
        <td><div>Referred: ${chip(x.sync?.referred)}${hsLink(x.referred_contact_id)}</div><div>Referrer: ${chip(x.sync?.referrer)}${hsLink(x.referrer_contact_id)}</div>${x.sync?.association && !x.sync.association.ok ? '<div><span class="chip chip--bad" title="The two contacts are not linked">not linked</span></div>' : ''}</td>
        <td><button class="btn btn--sm" data-view>Answers</button> <button class="btn btn--sm" data-resync>Resend</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
  $$('tr[data-id]').forEach((tr) => {
    const x = r.list.find((y) => y.id === tr.dataset.id);
    tr.querySelector('[data-view]').onclick = () => showReferral(x);
    tr.querySelector('[data-resync]').onclick = async (e) => {
      e.target.disabled = true;
      try { const o = await api('POST', {}, { action: 'referral-resync', id: x.id }); toast(o.result?.error ? `HubSpot: ${esc(o.result.error)}` : 'Sent to HubSpot again.'); renderReferrals(); }
      catch (err) { toast(esc(err.message), 7000); e.target.disabled = false; }
    };
  });
}
function showReferral(x) {
  const fields = S.draft ? S.draft.steps.flatMap((st) => st.sections.flatMap((s) => s.fields.map((f) => ({ f, step: st.key })))) : [];
  const show = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? (v.first != null ? `${v.first || ''} ${v.last || ''}` : [v.cc ? `+${v.cc}` : '', v.number].filter(Boolean).join(' ')) : String(v));
  const a = x.attribution || {};
  const touch = (t) => (t ? Object.entries(t).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') : '<dt>—</dt><dd></dd>');
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">${esc(full(x.referred_first_name, x.referred_last_name))}</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    <dl class="ans">${PAGES.map(([k, title]) => `<h3>${esc(title)}</h3>${fields.filter((y) => y.step === k).map(({ f }) => `<dt>${esc(f.label)}</dt><dd>${esc(show(x.answers?.[f.key]))}</dd>`).join('')}`).join('')}
    <h3>Referrer's first visit</h3>${touch(a.first)}<h3>Latest visit before referring</h3>${touch(a.last)}
    <h3>HubSpot</h3><dt>Sync</dt><dd>${esc(JSON.stringify(x.sync || {}, null, 1))}</dd></dl></div>`);
  d.querySelector('[data-x]').onclick = () => d.close();
}

boot();
