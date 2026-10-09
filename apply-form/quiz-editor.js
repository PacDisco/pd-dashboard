// apply-form/quiz-editor.js — editor for the gap-year quiz (pd-apply /quiz).
//
// The quiz is one JSON document stored in apply_forms as 'pd-quiz' (see
// quiz-kit.mjs for its shape). Changes autosave as a draft; visitors only see
// them after Publish. Until the first publish, pd-apply serves the quiz that
// ships with it (the same one "Set up the quiz" starts from).

import { esc } from '/apply-form/form-kit.mjs';
import { lintQuiz, scoreQuiz } from '/apply-form/quiz-kit.mjs';
import { classify } from '/apply-form/attribution-kit.mjs';

const API = '/api/apply-forms';
const SAVE_DELAY = 1200;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const S = { user: null, form: null, draft: null, rev: 0, lint: [], applySite: null, tab: 'questions', open: new Set(), hubspot: null,
  saveTimer: null, saving: false, dirty: false, saveError: null, resp: { q: '', list: [] } };

async function api(method, params = {}, body) {
  const qs = new URLSearchParams({ form: 'quiz', ...params }).toString();
  const res = await fetch(`${API}?${qs}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify({ form: 'quiz', ...body }) : undefined });
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
  S.dirty = true; S.lint = lintQuiz(S.draft);
  setSaveState('Unsaved changes');
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, SAVE_DELAY);
  if (rerender) render(); else { updateChrome(); renderLint(); }
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
    if (err.status === 409) { notice('bad', 'Someone else changed the quiz. <button class="btn btn--sm" id="reload">Reload their version</button>'); $('#reload')?.addEventListener('click', () => location.reload()); }
    setSaveState(`Not saved — ${err.message}`, true);
  } finally { S.saving = false; updateChrome(); }
}
function setSaveState(t, err = false) { const el = $('#save-state'); el.textContent = t; el.classList.toggle('err', err); }
function updateChrome() {
  const f = S.form;
  $('#status-chip').innerHTML = !f?.publishedRev ? '<span class="chip chip--draft" title="Visitors see the quiz that ships with pd-apply until you publish">Not published yet</span>'
    : (f.changes || S.dirty) ? '<span class="chip chip--changes">Unpublished changes</span>' : '<span class="chip chip--live">Live</span>';
  $('#btn-discard').classList.toggle('hidden', !(f?.publishedRev && f.changes));
  const errs = S.lint.filter((l) => l.level === 'error').length;
  const pub = $('#btn-publish');
  pub.disabled = !S.form || !S.user?.canPublish || errs > 0;
  pub.title = !S.user?.canPublish ? 'Publishing needs an admin or admissions lead.' : errs ? 'Fix the problems listed first.' : 'Make these changes live';
  if (S.applySite) { $('#open-live').href = `${S.applySite}/quiz`; $('#open-preview').href = `${S.applySite}/quiz?preview=1`; }
  else { $('#open-live').classList.add('hidden'); $('#open-preview').classList.add('hidden'); }
}
async function publish() {
  clearTimeout(S.saveTimer); await save();
  if (S.dirty || S.saveError) { toast('Save failed — fix that first.'); return; }
  const note = await promptDialog('Publish the quiz', 'Visitors see these changes within about 30 seconds. Add a short note (optional).', 'e.g. Pasted new result texts');
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
  if (!S.draft && S.tab !== 'responses') return renderInit();
  if (S.tab === 'questions') return renderQuestions();
  if (S.tab === 'results') return renderResults();
  if (S.tab === 'settings') return renderSettings();
  return renderResponses();
}
function renderInit() {
  $('#app').innerHTML = `<div class="page"><div class="panel"><h2 class="serif">Set up the quiz</h2><p class="sub">Starts from the 15-question quiz copied from Jotform (same answers, same scoring for the five results). Visitors keep seeing that same quiz until you publish.</p><button class="btn btn--primary" id="init">Set up the quiz</button></div></div>`;
  $('#init').onclick = async () => {
    try {
      const seed = await (await fetch('/apply-form/quiz-seed.json')).json();
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

// ── questions ───────────────────────────────────────────────────────────────
const quizSections = () => S.draft.steps.find((s) => s.key === 'quiz').sections;
const archs = () => S.draft.archetypes || [];

function maxPoints() {
  const out = Object.fromEntries(archs().map((a) => [a.key, 0]));
  for (const sec of quizSections()) for (const f of sec.fields) {
    const per = new Set();
    for (const ks of Object.values(f.scores || {})) for (const k of ks) per.add(k);
    for (const k of per) if (k in out) out[k] += 1;
  }
  return out;
}

function renderQuestions() {
  const secs = quizSections();
  const mp = maxPoints();
  $('#app').innerHTML = `<div class="page">
    <div id="lint"></div>
    <div class="panel"><h2 class="serif">How scoring works</h2><p class="sub">Each answer can give a point to one or more results — click the result names next to an answer. The result with the most points wins; ties go to the result listed first on the Results tab. On a “pick several” question a result scores at most one point, however many of its answers are ticked.</p>
      <div class="legend">${archs().map((a) => `<span class="chan">${esc(a.name)} · up to ${mp[a.key]} pts</span>`).join('')}</div></div>
    <div id="qs">${secs.map((sec, i) => questionCard(sec, i)).join('')}</div>
    <div class="acts"><button class="btn" id="addq">+ Add a question</button></div>
    <div class="panel"><h2 class="serif">Details page</h2><p class="sub">Asked after the last question, before the result is shown. Name, email and phone are written to the HubSpot contact.</p>
      ${S.draft.steps.find((s) => s.key === 'contact').sections[0].fields.map((f) => `<div class="row2"><div class="field"><label>${esc(f.key)} label</label><input type="text" data-cl="${esc(f.key)}" value="${esc(f.label)}"></div><label class="check" style="align-self:end"><input type="checkbox" data-creq="${esc(f.key)}"${f.required ? ' checked' : ''}${f.key === 'email' ? ' disabled' : ''}><span>Required</span></label></div>`).join('')}
      <div class="field"><label for="ctitle">Page heading</label><input type="text" id="ctitle" value="${esc(S.draft.steps.find((s) => s.key === 'contact').sections[0].title || '')}"></div></div>
  </div>`;
  renderLint();
  bindQuestions();
}

function questionCard(sec, i) {
  const f = sec.fields[0];
  const open = S.open.has(sec.key);
  const choice = ['radio', 'select', 'checkbox'].includes(f.type);
  return `<div class="qcard${open ? '' : ' closed'}" data-sec="${i}">
    <div class="qcard__head"><span class="n">${i + 1}</span><span class="t" data-toggle>${esc(f.label || '(no question)')}</span>
      <span class="reach">${Object.keys(f.scores || {}).length ? 'scored' : 'not scored'}</span>
      <button class="btn btn--icon btn--sm" data-up title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button class="btn btn--icon btn--sm" data-down title="Move down">↓</button>
      <button class="btn btn--icon btn--sm btn--danger" data-del title="Delete question">✕</button></div>
    <div class="qcard__body">
      <div class="field"><label>Question</label><input type="text" data-k="label" value="${esc(f.label)}"></div>
      <div class="row2"><div class="field"><label>Answer type</label><select data-k="type">${[['radio', 'Pick one'], ['checkbox', 'Pick several'], ['select', 'Dropdown (pick one)'], ['text', 'Short text'], ['textarea', 'Long text']].map(([v, l]) => `<option value="${v}"${f.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Hint under the question</label><input type="text" data-k="help" value="${esc(f.help || '')}"></div></div>
      <div class="row2"><label class="check"><input type="checkbox" data-k="required"${f.required ? ' checked' : ''}><span>Required</span></label>
        ${f.type === 'checkbox' ? `<div class="field"><label>Most answers they can pick</label><input type="number" min="0" max="20" data-k="maxChoices" value="${esc(f.maxChoices || '')}" placeholder="no limit"></div>` : '<span></span>'}</div>
      ${choice ? `<div class="lbl" style="font-size:12px;font-weight:600;color:var(--ink);margin:6px 0">Answers — and which results they score for</div>
        ${(f.options || []).map((o, k) => `<div class="optrow" data-opt="${k}"><input class="inp" type="text" data-o value="${esc(o)}"><div class="archs">${archs().map((a) => `<button type="button" data-a="${esc(a.key)}" aria-pressed="${(f.scores?.[o] || []).includes(a.key)}">${esc(a.name.replace(/^The /, ''))}</button>`).join('')}</div><button class="btn btn--icon btn--sm btn--danger" data-odel title="Remove answer">✕</button></div>`).join('')}
        <div class="acts"><button class="btn btn--sm" data-oadd>+ Add answer</button></div>` : ''}
      <details class="adv"><summary>HubSpot</summary><div class="field"><label>Also save this answer to a contact property (optional)</label>
        <select data-k="hubspot"><option value="">— only in “PD quiz answers” —</option>${(S.hubspot?.contactProps || []).map((p) => `<option value="${esc(p.name)}"${f.hubspot?.contact === p.name ? ' selected' : ''}>${esc(p.label)} (${esc(p.name)})</option>`).join('')}${f.hubspot?.contact && !(S.hubspot?.contactProps || []).some((p) => p.name === f.hubspot.contact) ? `<option selected value="${esc(f.hubspot.contact)}">${esc(f.hubspot.contact)}</option>` : ''}</select>
        <span class="help">Every answer is always written to the contact's “PD quiz answers” property.</span></div></details>
    </div></div>`;
}

function bindQuestions() {
  const secs = quizSections();
  if (!S.hubspot) api('GET', { action: 'hubspot' }).then((h) => { S.hubspot = h; if (S.tab === 'questions' && S.open.size) renderQuestions(); }).catch(() => { S.hubspot = { contactProps: [] }; });
  $$('.qcard').forEach((card) => {
    const i = Number(card.dataset.sec); const sec = secs[i]; const f = sec.fields[0];
    card.querySelector('[data-toggle]').onclick = () => { S.open.has(sec.key) ? S.open.delete(sec.key) : S.open.add(sec.key); card.classList.toggle('closed'); };
    card.querySelector('[data-up]').onclick = () => { if (i > 0) { [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; changed({ rerender: true }); } };
    card.querySelector('[data-down]').onclick = () => { if (i < secs.length - 1) { [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; changed({ rerender: true }); } };
    card.querySelector('[data-del]').onclick = async () => { if (await confirmDialog('Delete this question?', f.label || '')) { secs.splice(i, 1); changed({ rerender: true }); } };
    $$('[data-k]', card).forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      const k = el.dataset.k;
      if (k === 'required') f.required = el.checked;
      else if (k === 'maxChoices') { const n = Number(el.value); if (n > 0) f.maxChoices = n; else delete f.maxChoices; }
      else if (k === 'hubspot') { if (el.value) f.hubspot = { contact: el.value }; else delete f.hubspot; }
      else if (k === 'type') { f.type = el.value; if (!['radio', 'select', 'checkbox'].includes(f.type)) { delete f.options; delete f.scores; } else f.options = f.options || ['Option 1', 'Option 2']; if (f.type !== 'checkbox') delete f.maxChoices; changed({ rerender: true }); return; }
      else if (k === 'help') { if (el.value) f.help = el.value; else delete f.help; }
      else { f[k] = el.value; if (k === 'label') card.querySelector('[data-toggle]').textContent = el.value || '(no question)'; }
      changed();
    }));
    $$('[data-opt]', card).forEach((row) => {
      const k = Number(row.dataset.opt);
      row.querySelector('[data-o]').addEventListener('change', (e) => {
        const old = f.options[k]; const v = e.target.value.trim();
        if (!v || f.options.some((o, j) => j !== k && o === v)) { e.target.value = old; toast('Answers must be filled in and different.'); return; }
        f.options[k] = v;
        if (f.scores?.[old]) { f.scores[v] = f.scores[old]; delete f.scores[old]; }
        changed({ rerender: true });
      });
      $$('[data-a]', row).forEach((b) => b.onclick = () => {
        const o = f.options[k]; f.scores = f.scores || {};
        const list = new Set(f.scores[o] || []);
        list.has(b.dataset.a) ? list.delete(b.dataset.a) : list.add(b.dataset.a);
        if (list.size) f.scores[o] = [...list]; else delete f.scores[o];
        if (!Object.keys(f.scores).length) delete f.scores;
        b.setAttribute('aria-pressed', String(list.has(b.dataset.a)));
        changed();
      });
      row.querySelector('[data-odel]').onclick = () => { const o = f.options[k]; f.options.splice(k, 1); if (f.scores) delete f.scores[o]; changed({ rerender: true }); };
    });
    card.querySelector('[data-oadd]')?.addEventListener('click', () => { let n = f.options.length + 1; while (f.options.includes(`Option ${n}`)) n += 1; f.options.push(`Option ${n}`); changed({ rerender: true }); });
  });
  $('#addq').onclick = () => {
    let n = secs.length + 1; const used = new Set(secs.map((s) => s.fields[0].key));
    while (used.has(`q${n}`)) n += 1;
    secs.push({ key: `q_q${n}`, fields: [{ key: `q${n}`, type: 'radio', label: 'New question', required: true, options: ['Option 1', 'Option 2'] }] });
    S.open.add(`q_q${n}`); changed({ rerender: true });
  };
  const contact = S.draft.steps.find((s) => s.key === 'contact').sections[0];
  $$('[data-cl]').forEach((el) => el.addEventListener('input', () => { contact.fields.find((f) => f.key === el.dataset.cl).label = el.value; changed(); }));
  $$('[data-creq]').forEach((el) => el.addEventListener('change', () => { contact.fields.find((f) => f.key === el.dataset.creq).required = el.checked; changed(); }));
  $('#ctitle').addEventListener('input', (e) => { contact.title = e.target.value; changed(); });
}

// ── results ─────────────────────────────────────────────────────────────────
const textToHtml = (t) => (/<[a-z][\s\S]*>/i.test(t) ? t : t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''));

function renderResults() {
  const mp = maxPoints();
  $('#app').innerHTML = `<div class="page"><div id="lint"></div>
    <div class="panel"><h2 class="serif">Results</h2><p class="sub">What visitors see after the quiz. Paste each result's text into its box — plain text is fine (a blank line starts a new paragraph); simple HTML like &lt;strong&gt; and links also work. <strong>Order matters:</strong> when two results tie, the one higher in this list wins.</p></div>
    ${archs().map((a, i) => `<div class="qcard" data-ai="${i}"><div class="qcard__head"><span class="n">${i + 1}</span><span class="t">${esc(a.name)}</span><span class="reach">up to ${mp[a.key] || 0} pts · key <code>${esc(a.key)}</code></span>
      <button class="btn btn--icon btn--sm" data-up${i === 0 ? ' disabled' : ''}>↑</button><button class="btn btn--icon btn--sm" data-down>↓</button><button class="btn btn--icon btn--sm btn--danger" data-del>✕</button></div>
      <div class="qcard__body"><div class="row2"><div class="field"><label>Name</label><input type="text" data-k="name" value="${esc(a.name)}"></div><div class="field"><label>Heading on the result page</label><input type="text" data-k="headline" value="${esc(a.headline || '')}"></div></div>
      <div class="field"><label>Result text</label><textarea rows="7" data-k="html">${esc(a.html || '')}</textarea></div>
      <div class="row2"><div class="field"><label>Button label</label><input type="text" data-k="ctaLabel" value="${esc(a.ctaLabel || '')}" placeholder="Start your application"></div><div class="field"><label>Button link</label><input type="text" data-k="ctaUrl" value="${esc(a.ctaUrl || '/')}"><span class="help"><code>/</code> = the application, prefilled with their name, email and phone.</span></div></div>
      <div class="field" style="max-width:360px"><label>Value saved to HubSpot (“PD quiz result”)</label><input type="text" data-k="hubspotValue" value="${esc(a.hubspotValue || a.name)}"></div></div></div>`).join('')}
    <div class="acts"><button class="btn" id="adda">+ Add a result</button></div></div>`;
  renderLint();
  $$('[data-ai]').forEach((card) => {
    const i = Number(card.dataset.ai); const list = S.draft.archetypes; const a = list[i];
    $$('[data-k]', card).forEach((el) => el.addEventListener('input', () => { a[el.dataset.k] = el.value; if (el.dataset.k === 'name') card.querySelector('.t').textContent = el.value; changed(); }));
    card.querySelector('[data-k=html]').addEventListener('blur', (e) => { const h = textToHtml(e.target.value); if (h !== a.html) { a.html = h; e.target.value = h; changed(); } });
    card.querySelector('[data-up]').onclick = () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed({ rerender: true }); } };
    card.querySelector('[data-down]').onclick = () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed({ rerender: true }); } };
    card.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmDialog(`Delete “${a.name}”?`, 'Its scoring on every answer is removed too.'))) return;
      list.splice(i, 1);
      for (const sec of quizSections()) for (const f of sec.fields) for (const [o, ks] of Object.entries(f.scores || {})) { const left = ks.filter((k) => k !== a.key); if (left.length) f.scores[o] = left; else delete f.scores[o]; }
      changed({ rerender: true });
    };
  });
  $('#adda').onclick = () => {
    let n = archs().length + 1; while (archs().some((a) => a.key === `result${n}`)) n += 1;
    S.draft.archetypes.push({ key: `result${n}`, name: 'New result', headline: '', html: '', ctaLabel: 'Start your application', ctaUrl: '/', hubspotValue: 'New result' });
    changed({ rerender: true });
  };
}

// ── settings ────────────────────────────────────────────────────────────────
function renderSettings() {
  const st = S.draft.settings = S.draft.settings || {};
  const inp = (k, label, help = '', ph = '') => `<div class="field"><label for="st-${k}">${label}</label><input type="text" id="st-${k}" data-s="${k}" value="${esc(st[k] ?? '')}" placeholder="${esc(ph)}">${help ? `<span class="help">${help}</span>` : ''}</div>`;
  $('#app').innerHTML = `<div class="page"><div id="lint"></div>
    <div class="panel"><h2 class="serif">Wording</h2><div class="cols"><div>${inp('introTitle', 'Intro heading')}<div class="field"><label for="st-introBody">Intro text</label><textarea id="st-introBody" data-s="introBody" rows="3">${esc(st.introBody || '')}</textarea></div>${inp('startLabel', 'Start button', '', 'Start the quiz')}</div>
      <div>${inp('contactIntro', 'Text on the details page', '', 'We’ll show your result on the next screen…')}${inp('submitLabel', 'Submit button', '', 'See my result')}${inp('secondaryCtaLabel', 'Second button on the result', '', 'Talk to an advisor')}${inp('secondaryCtaUrl', 'Second button link', 'Leave empty to hide it.')}
      <label class="check"><input type="checkbox" id="st-scores"${st.showScores ? ' checked' : ''}><span>Show the points for every result under the result</span></label></div></div></div>
    <div class="panel"><h2 class="serif">HubSpot</h2><p class="sub">The quiz is submitted to this HubSpot form with the visitor's HubSpot cookie first, so HubSpot's Original Source is the real channel (not “Offline Sources”). Then the result, every answer, and the source details (UTMs, ad click, landing page, referring site) are written to the contact.</p>
      <div class="field" style="max-width:560px"><label for="st-hubspotFormGuid">HubSpot form ID</label><div style="display:flex;gap:8px"><input type="text" id="st-hubspotFormGuid" data-s="hubspotFormGuid" value="${esc(st.hubspotFormGuid || '')}" placeholder="e.g. 1a2b3c4d-5e6f-…"><button class="btn btn--sm" type="button" id="mkform">Create in HubSpot</button></div><span class="help">Turn off HubSpot's own notification emails for this form if you don't want one per quiz.</span></div>
      <div class="cols"><div class="field"><label for="st-leadStatus">Lead status for new contacts</label><select id="st-leadStatus" data-s="leadStatus">${[['', '— leave as is —'], ['NEW', 'New'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['ATTEMPTED_TO_CONTACT', 'Attempted to contact']].map(([v, l]) => `<option value="${v}"${(st.leadStatus || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select><span class="help">Never overwrites a lead status someone already set.</span></div>
        ${inp('archetypeProperty', 'Contact property for the result', '', 'pd_quiz_archetype')}${inp('answersProperty', 'Contact property for all answers', '', 'pd_quiz_answers')}</div>
      <p class="sub">Create these properties (and the source ones) with <a href="/lead-sources/">Lead Sources → Set up HubSpot properties</a>.</p></div>
  </div>`;
  renderLint();
  $$('[data-s]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { const v = el.value.trim(); if (v || el.dataset.s === 'leadStatus') st[el.dataset.s] = v; else delete st[el.dataset.s]; changed(); }));
  $('#st-scores').addEventListener('change', (e) => { st.showScores = e.target.checked; changed(); });
  $('#mkform').onclick = async (e) => {
    if (st.hubspotFormGuid && !(await confirmDialog('Create another HubSpot form?', 'A form ID is already set. Create a new one and use it instead?', 'Create', false))) return;
    e.target.disabled = true;
    try { const out = await api('POST', {}, { action: 'hubspot-form-create' }); st.hubspotFormGuid = out.id; $('#st-hubspotFormGuid').value = out.id; changed(); toast(`Created “${esc(out.name)}” in HubSpot. Publish to start using it.`, 7000); }
    catch (err) { toast(esc(err.message), 9000); } finally { e.target.disabled = false; }
  };
}

// ── responses ───────────────────────────────────────────────────────────────
async function renderResponses() {
  const r = S.resp;
  $('#app').innerHTML = `<div class="page"><div class="filters"><span id="counts"></span><input class="inp" id="q" placeholder="Search name or email" value="${esc(r.q)}" style="max-width:280px;margin-left:auto"></div><div id="body" class="loading">Loading…</div></div>`;
  let out;
  try { out = await api('GET', { action: 'quiz-responses', q: r.q }); } catch (err) { $('#body').innerHTML = `<div class="notice notice--bad">${esc(err.message)}</div>`; return; }
  r.list = out.responses;
  const nameOf = (k) => S.draft?.archetypes?.find((a) => a.key === k)?.name || k || '—';
  $('#counts').innerHTML = Object.entries(out.counts || {}).map(([k, n]) => `<span class="chan">${esc(nameOf(k))} · ${n}</span>`).join(' ');
  let qt; $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { r.q = e.target.value; renderResponses(); }, 400); });
  const body = $('#body'); body.classList.remove('loading');
  if (out.warning) { body.innerHTML = `<div class="notice notice--warn">${esc(out.warning)}</div>`; return; }
  if (!r.list.length) { body.innerHTML = '<div class="panel">No quiz responses yet.</div>'; return; }
  body.innerHTML = `<div style="overflow-x:auto"><table class="grid apps"><thead><tr><th>Taken</th><th>Person</th><th>Result</th><th>Came from</th><th>HubSpot</th><th></th></tr></thead><tbody>
    ${r.list.map((x) => {
      const c = classify(x.attribution?.first || x.attribution || {});
      const hs = x.sync?.hubspot;
      return `<tr data-id="${x.id}"><td>${new Date(x.created_at).toLocaleString()}</td><td><div class="nm">${esc(`${x.first_name || ''} ${x.last_name || ''}`.trim() || '—')}</div><div class="em">${esc(x.email)}</div></td>
        <td>${esc(nameOf(x.archetype))}</td><td><span class="chan">${esc(c.channel)}</span><div class="em">${esc([c.source, c.campaign].filter(Boolean).join(' › '))}</div></td>
        <td>${hs?.ok ? `<span class="chip chip--live">Synced</span>${x.sync?.form?.ok ? '' : ' <span class="chip chip--changes" title="Not submitted to the HubSpot form — Original Source may say Offline">no form</span>'}` : hs ? `<span class="chip chip--bad" title="${esc(hs.error || '')}">Failed</span>` : '<span class="chip chip--draft">Pending</span>'}
          ${x.hubspot_contact_id ? ` <a href="https://app.hubspot.com/contacts/3855728/record/0-1/${esc(x.hubspot_contact_id)}" target="_blank" rel="noopener">open ↗</a>` : ''}</td>
        <td><button class="btn btn--sm" data-view>Answers</button> <button class="btn btn--sm" data-resync>Resend</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
  $$('tr[data-id]').forEach((tr) => {
    const x = r.list.find((y) => y.id === tr.dataset.id);
    tr.querySelector('[data-view]').onclick = () => showResponse(x);
    tr.querySelector('[data-resync]').onclick = async (e) => {
      e.target.disabled = true;
      try { const o = await api('POST', {}, { action: 'quiz-resync', id: x.id }); toast(o.result?.error ? `HubSpot: ${esc(o.result.error)}` : 'Sent to HubSpot again.'); renderResponses(); }
      catch (err) { toast(esc(err.message), 7000); e.target.disabled = false; }
    };
  });
}
function showResponse(x) {
  const qs = S.draft ? S.draft.steps.find((s) => s.key === 'quiz').sections.map((s) => s.fields[0]) : [];
  const a = x.attribution || {};
  const touch = (t) => (t ? Object.entries(t).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') : '<dt>—</dt><dd></dd>');
  const scored = S.draft ? scoreQuiz(S.draft, x.answers || {}) : null;
  const d = openDialog(`<div class="dlg-head"><h2 class="serif">${esc(`${x.first_name || ''} ${x.last_name || ''}`)}</h2><button class="btn btn--sm" data-x>Close</button></div><div class="dlg-body">
    <dl class="ans"><h3>Answers</h3>${qs.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(Array.isArray(x.answers?.[f.key]) ? x.answers[f.key].join(', ') : x.answers?.[f.key] ?? '—')}</dd>`).join('')}
    <h3>Points</h3>${Object.entries(x.scores || {}).map(([k, n]) => `<dt>${esc(S.draft?.archetypes?.find((y) => y.key === k)?.name || k)}</dt><dd>${n}</dd>`).join('')}
    ${scored && scored.archetype !== x.archetype ? `<dt>With today's scoring</dt><dd>${esc(S.draft.archetypes.find((y) => y.key === scored.archetype)?.name || scored.archetype)}</dd>` : ''}
    <h3>First visit</h3>${touch(a.first)}<h3>Latest visit before the quiz</h3>${touch(a.last)}
    <h3>HubSpot</h3><dt>Visitor cookie sent</dt><dd>${a.hutk ? 'Yes' : 'No (blocked or first page view)'}</dd><dt>Sync</dt><dd>${esc(JSON.stringify(x.sync || {}, null, 1))}</dd></dl></div>`);
  d.querySelector('[data-x]').onclick = () => d.close();
}

boot();
