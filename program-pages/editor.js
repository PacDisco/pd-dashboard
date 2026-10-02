// program-pages/editor.js — the Program Pages visual editor.
//
// How it works
//   - The page is rendered in an iframe by the SAME template the public site
//     uses (template/render.mjs, a pinned copy of pd-program-pages/src/render.mjs),
//     with { editable: true }, which adds data-* hooks:
//       data-f="path"      text — edited right on the page (contenteditable)
//       data-v="path"      a number/date/choice — edited in the side panel
//       data-img="path"    an image — upload / pick / paste a URL in the panel
//       data-item="path"   one entry in a repeatable list (week, FAQ, date…)
//       data-add="path"    the "+ Add" button for a list
//       data-sec="key"     a section (show/hide, reorder in "Sections")
//   - Every change updates one JSON document (S.data). It autosaves as a draft
//     to /api/program-pages; nothing is public until someone presses Publish.
//   - The side panel forms are generated from SCHEMA in the template, so a new
//     field added there shows up here without touching this file.

import {
  renderProgram, PROGRAM_CSS, SCHEMA, SECTIONS, blankProgram, normalizeProgram,
  getPath, setPath, slugify, esc, findPlaceholders, dateRange, parseWidget,
} from '/program-pages/template/render.mjs';

// The public program site (pd-program-pages). Used for "View live" previews of
// the static build and for the template drift check. Never executed here.
const PROGRAM_SITE = 'https://pd-program-pages.netlify.app';
const LIVE_BASE = 'https://www.pacificdiscovery.org/programs/';
const API = '/api/program-pages';
const MEDIA = '/api/program-media';
const SAVE_DELAY = 1200;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  user: null, programs: [], showArchived: false,
  slug: null, rev: 0, data: null, status: 'draft', publishedRev: null,
  dirty: false, saving: false, saveTimer: null, savePending: false, saveError: null, conflict: null,
  sel: null, tab: 'edit', focusField: null,
  undo: [], redo: [], snap: '', snapTimer: null,
  doc: null, previewing: null, inline: null, library: null,
};

// ─── API ────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

async function api(method, params = {}, body) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) sessionExpired();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function sessionExpired() {
  notice('bad', 'Your sign-in has expired. <a href="/" target="_blank" rel="noopener">Sign in again in a new tab</a>, then come back — your changes are kept here and will save.');
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toast(html, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** A toast that stays up and can be updated, for long-running steps. */
function progressToast(html) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = html;
  document.body.appendChild(el);
  return { set: (h) => { el.innerHTML = h; }, done: () => el.remove() };
}

function notice(kind, html) {
  const n = $('#ed-notice');
  if (!kind) { n.className = 'notice hidden'; n.innerHTML = ''; return; }
  n.className = `notice notice--${kind}`;
  n.innerHTML = html;
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

const STATUS = {
  draft: ['chip--draft', 'Draft · not live'],
  live: ['chip--live', 'Live'],
  changes: ['chip--changes', 'Live · unpublished changes'],
  archived: ['chip--archived', 'Archived'],
};
const chip = (st) => `<span class="chip ${STATUS[st]?.[0] || ''}">${esc(STATUS[st]?.[1] || st)}</span>`;

const clone = (o) => JSON.parse(JSON.stringify(o));
const listPathOf = (itemPath) => itemPath.split('.').slice(0, -1).join('.');
const indexOf = (itemPath) => Number(itemPath.split('.').pop());
const sectionVisible = (key) => (S.data.layout || []).find((l) => l.key === key)?.show !== false;

// ─── routing ────────────────────────────────────────────────────────────────

function route() {
  const m = /^#\/edit\/([a-z0-9-]+)$/.exec(location.hash);
  if (m) openEditor(m[1]); else showList();
}
window.addEventListener('hashchange', () => {
  if (S.slug && (S.dirty || S.saving)) flushSave();
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ''; }
});

// ─── list view ──────────────────────────────────────────────────────────────

async function showList() {
  S.slug = null;
  $('#view-editor').classList.add('hidden');
  $('#view-list').classList.remove('hidden');
  document.title = 'Program Pages — Pacific Discovery';
  const body = $('#list-body');
  try {
    const r = await api('GET', S.showArchived ? { action: 'list', archived: '1' } : { action: 'list' });
    S.programs = r.programs; S.user = r.user;
    $('#list-error').classList.add('hidden');
  } catch (e) {
    $('#list-error').textContent = e.status === 403 ? e.message : `Couldn't load pages: ${e.message}`;
    $('#list-error').classList.remove('hidden');
    body.innerHTML = '';
    return;
  }
  if (!S.programs.length) {
    body.innerHTML = `<div class="empty"><h2 class="serif" style="font-size:24px">No program pages yet</h2>
      <p style="margin:0;max-width:46ch">Start with the South America starter, which already has the content from the current page. Or create a blank page.</p>
      <button class="btn btn--primary" type="button" id="btn-starter">Start with South America</button></div>`;
    $('#btn-starter').onclick = () => openNew({ name: 'South America', slug: 'south-america-gap-semester', from: 'starter:south-america' });
    return;
  }
  body.innerHTML = `<table class="pages"><thead><tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col">Last edited</th><th scope="col"><span class="hidden">Actions</span></th></tr></thead><tbody>${
    S.programs.map((p) => `<tr>
      <td><a class="nm" href="#/edit/${esc(p.slug)}">${esc(p.name)}</a><div class="sl">/programs/${esc(p.slug)}</div></td>
      <td>${chip(p.status)}${p.publishedAt ? `<div class="sl">Published ${esc(ago(p.publishedAt))}${p.publishedBy ? ` by ${esc(p.publishedBy)}` : ''}</div>` : ''}</td>
      <td>${esc(ago(p.updatedAt))}${p.updatedBy ? `<div class="sl">by ${esc(p.updatedBy)}</div>` : ''}</td>
      <td><div class="acts">
        ${p.status === 'archived'
          ? (S.user?.canPublish ? `<button class="btn btn--sm" type="button" data-unarchive="${esc(p.slug)}">Unarchive</button>` : '')
          : `<a class="btn btn--sm btn--primary" href="#/edit/${esc(p.slug)}">Edit</a>`}
        ${p.status === 'live' || p.status === 'changes' ? `<a class="btn btn--sm" href="${esc(LIVE_BASE + p.slug)}" target="_blank" rel="noopener">View live ↗</a>` : ''}
      </div></td></tr>`).join('')
  }</tbody></table>`;
  $$('[data-unarchive]').forEach((b) => b.onclick = async () => {
    try { await api('POST', {}, { action: 'unarchive', slug: b.dataset.unarchive }); showList(); } catch (e) { toast(esc(e.message)); }
  });
}

$('#show-archived').onchange = (e) => { S.showArchived = e.target.checked; showList(); };
$('#btn-new').onclick = () => openNew();

// ─── new page ───────────────────────────────────────────────────────────────

let slugTouched = false;
function openNew(pre = {}) {
  const dlg = $('#dlg-new');
  const sel = $('#new-from');
  sel.innerHTML = `<option value="blank">Blank template</option><option value="starter:south-america">South America starter (current page content)</option>` +
    S.programs.filter((p) => p.status !== 'archived').map((p) => `<option value="copy:${esc(p.slug)}">Copy of ${esc(p.name)}</option>`).join('');
  $('#new-name').value = pre.name || '';
  $('#new-slug').value = pre.slug || '';
  sel.value = pre.from || 'blank';
  slugTouched = !!pre.slug;
  $('#new-err').classList.add('hidden');
  dlg.showModal();
  $('#new-name').focus();
}
$('#new-name').oninput = (e) => { if (!slugTouched) $('#new-slug').value = slugify(e.target.value); };
$('#new-slug').oninput = () => { slugTouched = true; };
$('#form-new').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return;
  e.preventDefault();
  const name = $('#new-name').value.trim();
  const slug = $('#new-slug').value.trim();
  const from = $('#new-from').value;
  const err = $('#new-err');
  const go = $('#new-go');
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    err.textContent = 'Add a name and a web address using lowercase letters, numbers and hyphens.';
    err.classList.remove('hidden');
    return;
  }
  go.disabled = true;
  try {
    let data;
    if (from === 'blank') data = blankProgram(name);
    else if (from.startsWith('starter:')) {
      const res = await fetch(`/program-pages/starters/${from.slice(8)}.json`, { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load the starter content.');
      data = await res.json();
    } else {
      const r = await api('GET', { action: 'get', slug: from.slice(5) });
      data = clone(r.program.draft);
    }
    data.name = name;
    if (from !== 'starter:south-america' || name !== 'South America') data.seo = { ...(data.seo || {}), title: `${name} | Pacific Discovery` };
    await api('POST', {}, { action: 'create', slug, name, data });
    $('#dlg-new').close();
    location.hash = `#/edit/${slug}`;
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  } finally {
    go.disabled = false;
  }
});

// ─── editor: open / frame ───────────────────────────────────────────────────

async function openEditor(slug) {
  $('#view-list').classList.add('hidden');
  $('#view-editor').classList.remove('hidden');
  notice(null);
  Object.assign(S, { slug, sel: null, undo: [], redo: [], previewing: null, conflict: null, saveError: null, dirty: false, tab: 'edit' });
  $('#insp').innerHTML = '<div class="insp-body">Loading…</div>';
  try {
    const r = await api('GET', { action: 'get', slug });
    if (!S.user) { try { S.user = (await api('GET', { action: 'list' })).user; } catch { /* ignore */ } }
    const p = r.program;
    if (p.status === 'archived') { notice('warn', 'This page is archived. Unarchive it from the page list to edit.'); }
    S.data = normalizeProgram(p.draft);
    S.rev = p.draftRev;
    S.status = p.status;
    S.publishedRev = p.publishedRev;
    S.snap = JSON.stringify(S.data);
  } catch (e) {
    notice('bad', esc(e.status === 404 ? 'That page does not exist.' : e.message));
    return;
  }
  document.title = `${S.data.name} — Program Pages`;
  $('#btn-live').href = LIVE_BASE + slug;
  updateBar();
  setTab('edit');
  mountFrame();
  checkTemplateDrift();
  prepareGoogle()?.catch(() => { /* reported when someone clicks the button */ });
}

function mountFrame() {
  const frame = $('#frame');
  frame.onload = () => {
    S.doc = frame.contentDocument;
    wireFrame(S.doc);
    paint();
  };
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{margin:0;background:#fff}${PROGRAM_CSS}${EDIT_CSS}</style></head><body><div id="pdp-root"></div></body></html>`;
}

const EDIT_CSS = `
.pdp--edit [data-f],.pdp--edit [data-v]{cursor:pointer;border-radius:3px;outline-offset:3px}
.pdp--edit [data-f]:hover,.pdp--edit [data-v]:hover{outline:2px dashed rgba(40,129,149,.6)}
.pdp--edit [data-img]{cursor:pointer}
.pdp--edit [data-img]:hover{outline:3px dashed rgba(40,129,149,.75);outline-offset:-3px}
.pdp--edit [data-item]{position:relative}
.pdp--edit [data-item]:hover{box-shadow:0 0 0 2px rgba(85,187,210,.5)}
.pdp--edit .pde-sel{box-shadow:0 0 0 3px #288195!important}
.pdp--edit [contenteditable]{outline:2px solid #288195!important;background:rgba(85,187,210,.10);cursor:text}
.pdp--edit [data-empty]:empty::before{content:attr(data-empty);color:#8d969a;font-style:italic}
.pdp--edit .pdp-hero [data-empty]:empty::before{color:#d9eef3}
.pdp--edit [data-sec]{position:relative}
.pdp--edit [data-sec]:hover::after{content:attr(data-label);position:absolute;top:10px;left:10px;font:600 11px Poppins,sans-serif;background:#288195;color:#fff;padding:3px 8px;border-radius:6px;letter-spacing:.05em;text-transform:uppercase;pointer-events:none;z-index:4}
.pdp--edit .pde-hidden>.pdp-wrap{opacity:.4}
.pdp--edit .pde-hidden::before{content:"Hidden on the live page";position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#2f2f2f;color:#fff;font:600 12px Poppins,sans-serif;padding:4px 12px;border-radius:999px;z-index:5}
.pde-add{display:block;margin:10px 0 0;width:100%;border:2px dashed #b2d6df;background:rgba(255,255,255,.8);color:#1f6b7c;font:600 14px Poppins,sans-serif;border-radius:10px;padding:10px;cursor:pointer}
.pde-add:hover{background:#eef6f8;border-color:#55bbd2}
.pde-tools{position:absolute;top:-16px;right:10px;z-index:30;display:flex;gap:2px;background:#2f2f2f;border-radius:8px;padding:3px;box-shadow:0 6px 16px rgba(0,0,0,.2)}
.pde-tools button{border:0;background:transparent;color:#fff;min-width:30px;height:30px;border-radius:6px;cursor:pointer;font:500 13px Poppins,sans-serif;padding:0 6px}
.pde-tools button:hover,.pde-tools button:focus-visible{background:rgba(255,255,255,.18);outline:none}
.pdp--edit .pdp-bar{position:relative}
`;

function paint() {
  if (!S.doc) return;
  const root = S.doc.getElementById('pdp-root');
  if (!root) return;
  if (S.previewing) {
    root.innerHTML = renderProgram(S.previewing.data, { editable: false });
    return;
  }
  stopInline();
  root.innerHTML = renderProgram(S.data, { editable: true });
  markSelection();
}

let paintTimer = null;
function schedulePaint(ms = 250) {
  clearTimeout(paintTimer);
  paintTimer = setTimeout(() => { if (!S.inline) paint(); else schedulePaint(ms); }, ms);
}

function selElement() {
  const d = S.doc;
  const s = S.sel;
  if (!d || !s) return null;
  const q = (sel) => d.querySelector(sel);
  if (s.kind === 'item') return q(`[data-item="${CSS.escape(s.path)}"]`);
  if (s.kind === 'section') return q(`[data-sec="${CSS.escape(s.key)}"]`);
  if (s.kind === 'image') return q(`[data-img="${CSS.escape(s.path)}"]`);
  if (s.kind === 'group' && s.key === 'facts') return q('[data-group="facts"]');
  if (s.kind === 'group' && s.key === 'hero') return q('.pdp-hero');
  return null;
}

function markSelection() {
  const d = S.doc;
  if (!d) return;
  $$('.pde-sel', d).forEach((el) => el.classList.remove('pde-sel'));
  $$('.pde-tools', d).forEach((el) => el.remove());
  const el = selElement();
  if (!el) return;
  el.classList.add('pde-sel');
  const itemPath = S.sel.kind === 'item' ? S.sel.path : S.sel.kind === 'image' ? S.sel.item : null;
  const item = itemPath ? d.querySelector(`[data-item="${CSS.escape(itemPath)}"]`) : null;
  if (item) {
    const tools = d.createElement('div');
    tools.className = 'pde-tools';
    tools.setAttribute('role', 'toolbar');
    tools.innerHTML = `<button type="button" data-op="up" aria-label="Move up" title="Move up">↑</button><button type="button" data-op="down" aria-label="Move down" title="Move down">↓</button><button type="button" data-op="dup" aria-label="Duplicate" title="Duplicate">⧉</button><button type="button" data-op="del" aria-label="Delete" title="Delete">Delete</button>`;
    tools.dataset.path = itemPath;
    item.appendChild(tools);
  }
}

// ─── clicking & typing in the page ──────────────────────────────────────────

function ctxFor(el) {
  // The hero's "Next departure" card stands in for a row in the Dates list.
  const ref = el.closest('[data-ref-item]');
  if (ref) return { kind: 'item', path: ref.dataset.refItem };
  const item = el.closest('[data-item]');
  if (item) return { kind: 'item', path: item.dataset.item };
  if (el.closest('[data-group="facts"]')) return { kind: 'group', key: 'facts' };
  if (el.closest('.pdp-hero')) return { kind: 'group', key: 'hero' };
  const sec = el.closest('[data-sec]');
  if (sec) return { kind: 'section', key: sec.dataset.sec };
  return { kind: 'page' };
}

function wireFrame(d) {
  d.addEventListener('click', (e) => {
    if (S.previewing) { e.preventDefault(); return; }
    const t = e.target;
    if (t.closest('a')) e.preventDefault();
    const tool = t.closest('.pde-tools button');
    if (tool) { e.preventDefault(); itemOp(tool.closest('.pde-tools').dataset.path, tool.dataset.op); return; }
    const add = t.closest('[data-add]');
    if (add) { e.preventDefault(); addItem(add.dataset.add); return; }
    const img = t.closest('[data-img]');
    if (img) {
      const base = ctxFor(img);
      select({ kind: 'image', path: img.dataset.img, alt: img.dataset.alt || null, item: base.kind === 'item' ? base.path : null, parent: base });
      return;
    }
    const f = t.closest('[data-f]');
    if (f) {
      if (f.isContentEditable) return;
      select(ctxFor(f), f.dataset.url || f.dataset.f, { keepInline: true });
      startInline(f, e);
      return;
    }
    const v = t.closest('[data-v]');
    if (v) { select(ctxFor(v), v.dataset.v); return; }
    select(ctxFor(t));
  }, true);

  d.addEventListener('keydown', (e) => {
    if (S.inline) return;
    handleUndoKeys(e);
  });
  // Links and forms inside the preview never navigate.
  d.addEventListener('submit', (e) => e.preventDefault(), true);
}

const PLAIN = (() => { const el = document.createElement('div'); el.contentEditable = 'plaintext-only'; return el.contentEditable === 'plaintext-only'; })();

function startInline(el, ev) {
  stopInline();
  S.inline = el;
  el.contentEditable = PLAIN ? 'plaintext-only' : 'true';
  el.spellcheck = true;
  el.focus();
  // Put the caret where they clicked rather than at the start.
  const d = el.ownerDocument;
  try {
    const r = d.caretRangeFromPoint ? d.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
    if (r && el.contains(r.startContainer)) { const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); }
  } catch { /* fine */ }
  const ml = el.dataset.ml === '1';
  el.oninput = () => {
    let val = el.innerText.replace(/\r/g, '');
    if (val.endsWith('\n')) val = val.slice(0, -1);
    if (!ml) val = val.replace(/\n+/g, ' ');
    setPath(S.data, el.dataset.f, val);
    const input = document.getElementById(fieldId(el.dataset.f));
    if (input && input !== document.activeElement) input.value = val;
    changed({ paint: false });
  };
  el.onkeydown = (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && !ml)) { e.preventDefault(); el.blur(); }
  };
  el.onpaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    d.execCommand('insertText', false, ml ? text : text.replace(/\s*\n\s*/g, ' '));
  };
  el.onblur = () => stopInline();
}

function stopInline() {
  const el = S.inline;
  if (!el) return;
  S.inline = null;
  el.removeAttribute('contenteditable');
  el.oninput = el.onkeydown = el.onpaste = el.onblur = null;
  // An emptied field shows its placeholder again.
  if (!el.textContent) el.innerHTML = '';
}

// ─── changing data ──────────────────────────────────────────────────────────

function changed({ paint: doPaint = true } = {}) {
  S.dirty = true;
  if (doPaint) schedulePaint();
  clearTimeout(S.snapTimer);
  S.snapTimer = setTimeout(takeSnapshot, 700);
  scheduleSave();
  updateBar();
}

function takeSnapshot() {
  const now = JSON.stringify(S.data);
  if (now === S.snap) return;
  S.undo.push(S.snap);
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  S.snap = now;
  updateUndoButtons();
}

function undo(dir = -1) {
  clearTimeout(S.snapTimer);
  takeSnapshot();
  const from = dir < 0 ? S.undo : S.redo;
  const to = dir < 0 ? S.redo : S.undo;
  if (!from.length) return;
  to.push(S.snap);
  S.snap = from.pop();
  S.data = JSON.parse(S.snap);
  S.dirty = true;
  scheduleSave();
  paint();
  renderPanel();
  updateBar();
  updateUndoButtons();
}

function handleUndoKeys(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.key.toLowerCase() !== 'z') return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  e.preventDefault();
  undo(e.shiftKey ? 1 : -1);
}
document.addEventListener('keydown', handleUndoKeys);
$('#btn-undo').onclick = () => undo(-1);
$('#btn-redo').onclick = () => undo(1);
function updateUndoButtons() {
  $('#btn-undo').disabled = !S.undo.length && JSON.stringify(S.data) === S.snap;
  $('#btn-redo').disabled = !S.redo.length;
}

function addItem(listPath) {
  const def = SCHEMA.lists[listPath];
  if (!def) return;
  const list = getPath(S.data, listPath) || [];
  list.push(clone(def.blank));
  setPath(S.data, listPath, list);
  const path = `${listPath}.${list.length - 1}`;
  S.sel = { kind: 'item', path };
  changed({ paint: false });
  paint();
  renderPanel();
  selElement()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function itemOp(path, op) {
  const lp = listPathOf(path);
  const i = indexOf(path);
  const list = getPath(S.data, lp);
  if (!Array.isArray(list) || !list[i]) return;
  const label = SCHEMA.lists[lp]?.label || 'Item';
  if (op === 'up' && i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; S.sel = { kind: 'item', path: `${lp}.${i - 1}` }; }
  else if (op === 'down' && i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; S.sel = { kind: 'item', path: `${lp}.${i + 1}` }; }
  else if (op === 'dup') { list.splice(i + 1, 0, clone(list[i])); S.sel = { kind: 'item', path: `${lp}.${i + 1}` }; }
  else if (op === 'del') {
    list.splice(i, 1);
    S.sel = null;
    toast(`${esc(label)} deleted. <a href="#" id="toast-undo">Undo</a>`);
    setTimeout(() => { const u = $('#toast-undo'); if (u) u.onclick = (e) => { e.preventDefault(); undo(-1); }; });
  } else return;
  changed({ paint: false });
  clearTimeout(S.snapTimer);
  takeSnapshot();
  paint();
  renderPanel();
}

function moveSection(key, dir) {
  const L = S.data.layout;
  const i = L.findIndex((l) => l.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= L.length) return;
  [L[i], L[j]] = [L[j], L[i]];
  changed();
  renderPanel();
}

function toggleSection(key, show) {
  const l = S.data.layout.find((x) => x.key === key);
  if (l) l.show = show;
  changed();
  renderPanel();
}

// ─── saving ─────────────────────────────────────────────────────────────────

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, SAVE_DELAY);
}

function flushSave() {
  clearTimeout(S.saveTimer);
  return save();
}

async function save() {
  if (!S.slug || !S.dirty || S.conflict) return;
  if (S.saving) { S.savePending = true; return; }
  S.saving = true;
  S.dirty = false;
  updateBar();
  const slug = S.slug;
  const draft = clone(S.data);
  try {
    const r = await api('POST', {}, { action: 'save', slug, rev: S.rev, draft });
    if (slug !== S.slug) return;
    S.rev = r.rev;
    S.saveError = null;
    if (S.status === 'live') S.status = 'changes';
  } catch (e) {
    S.dirty = true;
    if (e.status === 409 && e.body?.conflict) {
      S.conflict = e.body.conflict;
      notice('warn', `${esc(e.message)} <button class="btn btn--sm" type="button" id="cf-theirs">Load their version</button><button class="btn btn--sm" type="button" id="cf-mine">Keep mine (replace theirs)</button>`);
      $('#cf-theirs').onclick = () => { S.dirty = false; S.conflict = null; openEditor(S.slug); };
      $('#cf-mine').onclick = () => { S.rev = S.conflict.rev; S.conflict = null; notice(null); save(); };
    } else {
      S.saveError = e.message;
      if (e.status !== 401 && e.status !== 400) setTimeout(() => { if (S.dirty) save(); }, 5000);
      if (e.status === 400) notice('bad', `Couldn't save: ${esc(e.message)}`);
    }
  } finally {
    S.saving = false;
    updateBar();
    if (S.savePending) { S.savePending = false; save(); }
  }
}

function updateBar() {
  if (!S.data) return;
  $('#ed-name').textContent = S.data.name || S.slug;
  $('#ed-status').innerHTML = chip(S.status);
  const st = $('#ed-save');
  st.classList.toggle('err', !!S.saveError || !!S.conflict);
  st.textContent = S.conflict ? 'Not saved — see above' : S.saveError ? 'Couldn’t save — retrying' : S.saving ? 'Saving…' : S.dirty ? 'Unsaved changes' : 'All changes saved';
  const pub = $('#btn-publish');
  pub.textContent = S.status === 'draft' ? 'Publish…' : 'Publish changes…';
  pub.disabled = S.status === 'archived';
  updateUndoButtons();
}

// ─── panel ──────────────────────────────────────────────────────────────────

$$('.insp-tabs button').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
function setTab(tab) {
  S.tab = tab;
  $$('.insp-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  renderPanel();
}

function select(sel, focusField = null, opts = {}) {
  if (!opts.keepInline) stopInline();
  S.sel = sel;
  S.focusField = focusField;
  if (S.tab !== 'edit') setTab('edit'); else renderPanel();
  markSelection();
}

const fieldId = (path) => `f-${path.replace(/[^a-z0-9]/gi, '_')}`;

function fieldHtml(f, path) {
  const id = fieldId(path);
  const val = getPath(S.data, path);
  const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  const lbl = `<label for="${id}">${esc(f.label)}</label>`;
  const v = val == null ? '' : val;
  switch (f.type) {
    case 'multiline': return `<div class="field" data-path="${esc(path)}">${lbl}<textarea id="${id}" data-path="${esc(path)}" data-type="text">${esc(v)}</textarea>${help}</div>`;
    case 'number': return `<div class="field" data-path="${esc(path)}">${lbl}<input type="number" min="0" id="${id}" data-path="${esc(path)}" data-type="number" value="${esc(v)}">${help}</div>`;
    case 'money': return `<div class="field" data-path="${esc(path)}">${lbl}<div class="money"><span>${esc(S.data.settings?.currency || 'USD')} $</span><input type="number" min="0" step="50" id="${id}" data-path="${esc(path)}" data-type="number" value="${esc(v)}"></div>${help}</div>`;
    case 'date': return `<div class="field" data-path="${esc(path)}">${lbl}<input type="date" id="${id}" data-path="${esc(path)}" data-type="text" value="${esc(v)}">${help}</div>`;
    case 'url': return `<div class="field" data-path="${esc(path)}">${lbl}<input type="url" id="${id}" data-path="${esc(path)}" data-type="text" value="${esc(v)}" placeholder="https://…">${v ? `<a class="help" href="${esc(v)}" target="_blank" rel="noopener">Test link ↗</a>` : ''}${help}</div>`;
    case 'select': return `<div class="field" data-path="${esc(path)}">${lbl}<select id="${id}" data-path="${esc(path)}" data-type="text">${(f.options || []).map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${help}</div>`;
    case 'image': return `<div class="field" data-path="${esc(path)}"><span class="lbl">${esc(f.label)}</span>${imageBox(path, null)}${help}</div>`;
    default: return `<div class="field" data-path="${esc(path)}">${lbl}<input type="text" id="${id}" data-path="${esc(path)}" data-type="text" value="${esc(v)}">${help}</div>`;
  }
}

function imageBox(path, altPath) {
  const src = getPath(S.data, path);
  return `<div class="imgbox">${src ? `<img src="${esc(src)}" alt="">` : '<div class="none">No photo yet</div>'}</div>
    <div class="imgacts">
      <label class="btn btn--sm btn--primary">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload="${esc(path)}" class="hidden"></label>
      <button class="btn btn--sm" type="button" data-drive="${esc(path)}"${altPath ? ` data-drive-alt="${esc(altPath)}"` : ''}>From Google Drive</button>
      <button class="btn btn--sm" type="button" data-library="${esc(path)}">Choose uploaded</button>
      ${src ? `<button class="btn btn--sm btn--danger" type="button" data-clear="${esc(path)}">Remove</button>` : ''}
    </div>
    <div class="field" style="margin-top:10px"><label for="${fieldId(path)}">…or paste an image link</label><input type="url" id="${fieldId(path)}" data-path="${esc(path)}" data-type="text" data-repaint-panel="1" value="${esc(src || '')}" placeholder="https://www.pacificdiscovery.org/library/images/…"></div>
    ${altPath ? fieldHtml({ label: 'Describe the photo (for screen readers and Google)', type: 'text' }, altPath) : ''}
    <div class="lib hidden" data-lib-for="${esc(path)}"></div>`;
}

function renderPanel() {
  const box = $('#insp');
  if (!S.data) return;
  let head = '';
  let body = '';
  if (S.previewing) {
    head = 'Previewing an older version';
    body = `<p class="hint">You're looking at the version published ${esc(ago(S.previewing.createdAt))}${S.previewing.createdBy ? ` by ${esc(S.previewing.createdBy)}` : ''}. Nothing here is editable.</p>
      <div class="item-acts"><button class="btn btn--primary btn--sm" type="button" id="pv-restore">Restore into draft</button><button class="btn btn--sm" type="button" id="pv-back">Back to editing</button></div>`;
  } else if (S.tab === 'sections') {
    head = 'Sections';
    body = `<p class="hint">Turn sections on or off and change their order. Hidden sections stay in the editor (faded) so you can turn them back on.</p>` +
      S.data.layout.map((l, i) => {
        const meta = SECTIONS.find((s) => s.key === l.key);
        return `<div class="secrow${l.show ? '' : ' off'}"><input type="checkbox" id="sec-${l.key}" data-sec-toggle="${l.key}"${l.show ? ' checked' : ''} aria-label="Show ${esc(meta.label)}">
          <span class="lbl" data-sec-go="${l.key}">${esc(meta.label)}</span>
          <button class="btn btn--sm btn--icon" type="button" data-sec-move="${l.key}" data-dir="-1" aria-label="Move ${esc(meta.label)} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button class="btn btn--sm btn--icon" type="button" data-sec-move="${l.key}" data-dir="1" aria-label="Move ${esc(meta.label)} down"${i === S.data.layout.length - 1 ? ' disabled' : ''}>↓</button></div>`;
      }).join('');
  } else if (S.tab === 'page') {
    head = 'Page settings';
    body = SCHEMA.page.fields.map((f) => fieldHtml(f, f.k)).join('') +
      `<div class="field"><span class="lbl">Web address</span><span>/programs/${esc(S.slug)}</span><span class="help">The address can't be changed after a page is created. To move a page, copy it to a new page.</span></div>` +
      (S.user?.canPublish ? `<div class="item-acts" style="margin-top:20px">${
        S.status === 'live' || S.status === 'changes'
          ? '<button class="btn btn--sm btn--danger" type="button" id="pg-unpublish">Take page offline</button>'
          : '<button class="btn btn--sm btn--danger" type="button" id="pg-archive">Archive page</button>'}</div>
          <p class="help" style="font-size:12px;color:var(--muted)">Taking a page offline puts the old pacificdiscovery.org page back at this address.</p>` : '') +
      `<div id="drift"></div>`;
  } else if (S.tab === 'history') {
    head = 'History';
    body = '<p class="hint">Every publish is kept. Preview an older version, or restore it into the draft and publish it again.</p><div id="ver-list">Loading…</div>';
  } else {
    const s = S.sel;
    if (!s || s.kind === 'page') {
      head = 'Edit';
      body = `<p class="hint"><strong>Click anything on the page to change it.</strong><br>Text edits right where it is. Photos, prices, dates and links open here.<br><br>Use the <strong>+ Add</strong> buttons to add weeks, questions and dates, and the toolbar on a selected item to move, copy or delete it.</p>` +
        `<p class="hint">Changes save automatically as a draft. The live site only changes when you press <strong>Publish</strong>.</p>`;
    } else if (s.kind === 'item') {
      const lp = listPathOf(s.path);
      const def = SCHEMA.lists[lp];
      const i = indexOf(s.path);
      const list = getPath(S.data, lp) || [];
      head = `${def?.label || 'Item'} ${i + 1} of ${list.length}`;
      body = `<div class="item-acts">
          <button class="btn btn--sm" type="button" data-op="up"${i === 0 ? ' disabled' : ''}>↑ Move up</button>
          <button class="btn btn--sm" type="button" data-op="down"${i === list.length - 1 ? ' disabled' : ''}>↓ Move down</button>
          <button class="btn btn--sm" type="button" data-op="dup">Duplicate</button>
          <button class="btn btn--sm btn--danger" type="button" data-op="del">Delete</button></div>` +
        (def?.fields || []).map((f) => {
          if (f.type === 'image') {
            const alt = def.fields.find((x) => x.k === `${f.k}Alt`);
            return `<div class="field"><span class="lbl">${esc(f.label)}</span>${imageBox(`${s.path}.${f.k}`, alt ? `${s.path}.${alt.k}` : null)}</div>`;
          }
          if (f.k.endsWith('Alt') && def.fields.some((x) => x.type === 'image' && `${x.k}Alt` === f.k)) return '';
          return fieldHtml(f, `${s.path}.${f.k}`);
        }).join('') +
        `<p><button class="btn btn--sm" type="button" data-select-sec="${esc(lp.split('.')[0])}">Section settings →</button></p>`;
    } else if (s.kind === 'group') {
      const g = SCHEMA[s.key];
      head = g.label;
      body = g.fields.map((f) => {
        if (f.type === 'image') return `<div class="field"><span class="lbl">${esc(f.label)}</span>${imageBox(f.k, s.key === 'hero' ? 'hero.imageAlt' : null)}</div>`;
        if (f.k === 'hero.imageAlt') return '';
        return fieldHtml(f, f.k);
      }).join('');
    } else if (s.kind === 'section') {
      const meta = SECTIONS.find((x) => x.key === s.key);
      const show = sectionVisible(s.key);
      head = meta.label;
      body = `<div class="field"><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" data-sec-toggle="${s.key}"${show ? ' checked' : ''}> Show this section on the live page</label></div>
        <div class="item-acts"><button class="btn btn--sm" type="button" data-sec-move="${s.key}" data-dir="-1">↑ Move section up</button><button class="btn btn--sm" type="button" data-sec-move="${s.key}" data-dir="1">↓ Move section down</button></div>` +
        (SCHEMA.sections[s.key]?.fields || []).map((f) => f.type === 'image'
          ? `<div class="field"><span class="lbl">${esc(f.label)}</span>${imageBox(f.k, f.k === 'route.mapImage' ? 'route.mapAlt' : null)}</div>`
          : (f.k === 'route.mapAlt' ? '' : fieldHtml(f, f.k))).join('') +
        (s.key === 'cta' || s.key === 'dates' ? `<p class="help" style="font-size:12px;color:var(--muted)">Button links come from Page settings.</p>` : '');
    } else if (s.kind === 'image') {
      head = 'Photo';
      body = imageBox(s.path, s.alt) + (s.parent && s.parent.kind !== 'page'
        ? `<p style="margin-top:14px"><button class="btn btn--sm" type="button" id="img-parent">← Back to ${s.parent.kind === 'item' ? 'item' : 'section'}</button></p>` : '');
    }
  }
  box.innerHTML = `<div class="insp-head"><h2>${esc(head)}</h2></div><div class="insp-body">${body}</div>`;
  wirePanel(box);
  if (S.tab === 'history' && !S.previewing) loadVersions();
  if (S.tab === 'page') showDrift();
  if (S.focusField) {
    const fieldEl = box.querySelector(`.field[data-path="${CSS.escape(S.focusField)}"]`);
    if (fieldEl) {
      fieldEl.classList.add('flash');
      fieldEl.scrollIntoView({ block: 'nearest' });
      const input = fieldEl.querySelector('input,select,textarea');
      if (input && !S.inline) input.focus();
    }
    S.focusField = null;
  }
}

function wirePanel(box) {
  box.querySelectorAll('[data-path][data-type]').forEach((input) => {
    const ev = input.tagName === 'SELECT' || input.type === 'date' ? 'change' : 'input';
    input.addEventListener(ev, () => {
      const path = input.dataset.path;
      let val = input.value;
      if (input.dataset.type === 'number') val = val === '' ? '' : Number(val);
      setPath(S.data, path, val);
      if (path === 'name') { updateBar(); document.title = `${val} — Program Pages`; }
      changed();
      if (input.dataset.repaintPanel) setTimeout(renderPanel, 400);
    });
  });
  box.querySelectorAll('[data-op]').forEach((b) => b.onclick = () => itemOp(S.sel.path, b.dataset.op));
  box.querySelectorAll('[data-sec-toggle]').forEach((c) => c.onchange = () => toggleSection(c.dataset.secToggle, c.checked));
  box.querySelectorAll('[data-sec-move]').forEach((b) => b.onclick = () => moveSection(b.dataset.secMove, Number(b.dataset.dir)));
  box.querySelectorAll('[data-sec-go]').forEach((b) => b.onclick = () => {
    const el = S.doc?.querySelector(`[data-sec="${CSS.escape(b.dataset.secGo)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  box.querySelectorAll('[data-select-sec]').forEach((b) => b.onclick = () => select({ kind: 'section', key: b.dataset.selectSec }));
  box.querySelectorAll('[data-upload]').forEach((inp) => inp.onchange = () => uploadImage(inp));
  box.querySelectorAll('[data-library]').forEach((b) => b.onclick = () => showLibrary(b.dataset.library));
  box.querySelectorAll('[data-drive]').forEach((b) => b.onclick = () => openDrive(b.dataset.drive, b.dataset.driveAlt || null));
  box.querySelectorAll('[data-clear]').forEach((b) => b.onclick = () => { setPath(S.data, b.dataset.clear, ''); changed(); renderPanel(); });
  const parent = box.querySelector('#img-parent');
  if (parent) parent.onclick = () => select(S.sel.parent);
  const pr = box.querySelector('#pv-restore');
  if (pr) pr.onclick = () => restoreVersion(S.previewing.id);
  const pb = box.querySelector('#pv-back');
  if (pb) pb.onclick = endPreview;
  const un = box.querySelector('#pg-unpublish');
  if (un) un.onclick = unpublish;
  const ar = box.querySelector('#pg-archive');
  if (ar) ar.onclick = archive;
}

// ─── images ─────────────────────────────────────────────────────────────────

async function shrink(file) {
  if (file.type === 'image/gif') return file;
  const MAX = 2400;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => c.toBlob(r, type, 0.86));
  return blob && blob.size < file.size ? new File([blob], file.name, { type }) : file;
}

/** Resize in the browser, store via /api/program-media, set it on `path`. */
async function uploadFile(file, path, { name = file.name, alt = null, altText = '' } = {}) {
  const small = await shrink(file);
  const res = await fetch(MEDIA, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': small.type, 'X-Filename': String(name || '').slice(0, 120) },
    body: small,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) sessionExpired();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  setPath(S.data, path, body.url);
  if (alt && altText && !String(getPath(S.data, alt) || '').trim()) setPath(S.data, alt, altText);
  S.library = null;
  changed();
  renderPanel();
  return body;
}

async function uploadImage(input) {
  const file = input.files?.[0];
  if (!file) return;
  const label = input.closest('label');
  label.firstChild.textContent = 'Uploading…';
  try {
    await uploadFile(file, input.dataset.upload);
    toast('Photo uploaded. Add a short description of it underneath.');
  } catch (e) {
    toast(`Upload failed: ${esc(e.message)}`);
    label.firstChild.textContent = 'Upload photo';
  }
}

async function showLibrary(path) {
  const grid = document.querySelector(`[data-lib-for="${CSS.escape(path)}"]`);
  if (!grid) return;
  grid.classList.remove('hidden');
  grid.innerHTML = '<span class="help">Loading…</span>';
  try {
    if (!S.library) {
      const res = await fetch(`${MEDIA}?action=list`, { credentials: 'include' });
      S.library = (await res.json()).items || [];
    }
    if (!S.library.length) { grid.innerHTML = '<span class="help">No uploaded photos yet.</span>'; return; }
    grid.innerHTML = S.library.map((it) => `<button type="button" data-pick="${esc(it.url)}" aria-label="Use ${esc(it.name || it.key)}"><img src="${esc(it.url)}" alt="" loading="lazy"></button>`).join('');
    grid.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { setPath(S.data, path, b.dataset.pick); changed(); renderPanel(); });
  } catch (e) {
    grid.innerHTML = `<span class="help">Couldn't load photos: ${esc(e.message)}</span>`;
  }
}

// ─── Google Drive (Google Picker, signed in as the editor) ───────────────────
// Each editor signs in with their own Google account and sees everything they
// can open in Drive: My Drive, shared drives, shared with me. The scope is
// drive.readonly: Google's picker only draws thumbnails for files the app can
// read, so with the narrower drive.file most previews were blank. Read-only
// means the dashboard can't change, delete or share anything, and it only ever
// downloads the one photo a person picks. The OAuth app is Internal
// (pacificdiscovery.org accounts only). The access token lives in this tab's
// memory only and is never sent to the dashboard's server.
// A picked photo is downloaded in the browser, resized, and stored in program
// media like any upload, so the live page never depends on the Drive file.

const GOOGLE = { cfg: null, ready: false, loading: null, token: null, tokenExp: 0, tokenClient: null, error: null };
const PICK_TYPES = 'image/jpeg,image/png,image/webp,image/gif';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement('script');
    el.src = src; el.async = true; el.onload = resolve;
    el.onerror = () => reject(new Error(`Couldn't load ${new URL(src).host}`));
    document.head.appendChild(el);
  });
}

/** Load config + Google's scripts ahead of time, so the click can open the sign-in popup straight away. */
function prepareGoogle() {
  if (GOOGLE.ready || GOOGLE.loading) return GOOGLE.loading;
  GOOGLE.loading = (async () => {
    const res = await fetch('/api/program-drive?action=config', { credentials: 'include' });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `Google Drive setup check failed (HTTP ${res.status})`);
    GOOGLE.cfg = body;
    await Promise.all([loadScript('https://apis.google.com/js/api.js'), loadScript('https://accounts.google.com/gsi/client')]);
    await new Promise((resolve) => window.gapi.load('picker', resolve));
    GOOGLE.ready = true;
  })().catch((e) => { GOOGLE.error = e.message; GOOGLE.loading = null; throw e; });
  return GOOGLE.loading;
}

function googleToken() {
  return new Promise((resolve, reject) => {
    if (GOOGLE.token && Date.now() < GOOGLE.tokenExp) return resolve(GOOGLE.token);
    if (!GOOGLE.tokenClient) {
      GOOGLE.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE.cfg.clientId,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: () => {},
      });
    }
    GOOGLE.tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error === 'access_denied' ? 'Google sign-in was cancelled.' : r.error));
      GOOGLE.token = r.access_token;
      GOOGLE.tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
      resolve(GOOGLE.token);
    };
    GOOGLE.tokenClient.error_callback = (e) => reject(new Error(e?.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed. Allow pop-ups for the dashboard and try again.'));
    GOOGLE.tokenClient.requestAccessToken({ prompt: GOOGLE.token ? '' : 'select_account' });
  });
}

function openDrive(path, altPath) {
  if (!GOOGLE.ready) {
    // Must stay inside the click for the sign-in popup, so don't await here.
    prepareGoogle()?.then(() => toast('Google Drive is ready. Click “From Google Drive” again.'))
      .catch((e) => toast(esc(e.message)));
    if (GOOGLE.error) toast(esc(GOOGLE.error)); else toast('Connecting to Google Drive…');
    return;
  }
  googleToken().then((token) => showPicker(token, path, altPath)).catch((e) => toast(esc(e.message)));
}

function showPicker(token, path, altPath) {
  const P = window.google.picker;
  const images = () => new P.DocsView(P.ViewId.DOCS_IMAGES).setMimeTypes(PICK_TYPES).setIncludeFolders(true).setSelectFolderEnabled(false);
  const picker = new P.PickerBuilder()
    .setTitle('Choose a photo')
    .addView(new P.DocsView(P.ViewId.DOCS_IMAGES).setMimeTypes(PICK_TYPES)) // all photos you can open
    .addView(images().setOwnedByMe(true))   // My Drive
    .addView(images().setEnableDrives(true)) // Shared drives
    .addView(images().setOwnedByMe(false))  // Shared with me
    .enableFeature(P.Feature.SUPPORT_DRIVES)
    .setOAuthToken(token)
    .setDeveloperKey(GOOGLE.cfg.apiKey)
    .setAppId(GOOGLE.cfg.appId)
    .setOrigin(`${location.protocol}//${location.host}`)
    .setCallback((data) => {
      if (data[P.Response.ACTION] !== P.Action.PICKED) return;
      const doc = data[P.Response.DOCUMENTS][0];
      importFromDrive(doc, token, path, altPath);
    })
    .build();
  picker.setVisible(true);
}

async function importFromDrive(doc, token, path, altPath) {
  const D = window.google.picker.Document;
  const id = doc[D.ID] || doc.id;
  const name = doc[D.NAME] || doc.name || 'photo';
  const description = doc[D.DESCRIPTION] || doc.description || '';
  const mb = (n) => (n / 1048576).toFixed(1);
  const t = progressToast(`Downloading ${esc(name)} from Drive…`);
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? 'Google wouldn’t share that file. Do you still have access to it?' : `Drive download failed (HTTP ${res.status})`);
    // Stream it so people can see a big original coming down rather than a frozen screen.
    const total = Number(res.headers.get('content-length')) || Number(doc.sizeBytes) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      t.set(`Downloading ${esc(name)}… ${mb(got)}${total ? ` of ${mb(total)}` : ''} MB`);
    }
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || doc.mimeType || 'image/jpeg' });
    t.set(`Resizing and saving ${esc(name)}…`);
    const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (doc.mimeType || 'image/jpeg');
    await uploadFile(new File([blob], name, { type }), path, { name, alt: altPath, altText: description.slice(0, 300) });
    t.done();
    toast(altPath && !description ? 'Photo added from Drive. Add a short description of it underneath.' : 'Photo added from Drive.');
  } catch (e) {
    t.done();
    toast(`Import failed: ${esc(e.message)}`);
  }
}

// ─── history ────────────────────────────────────────────────────────────────

async function loadVersions() {
  const box = $('#ver-list');
  try {
    const r = await api('GET', { action: 'versions', slug: S.slug });
    if (!r.versions.length) { box.innerHTML = '<p class="help">Nothing published yet.</p>'; return; }
    const kinds = { publish: 'Published', unpublish: 'Taken offline', restore: 'Restored' };
    box.innerHTML = r.versions.map((v) => `<div class="ver"><strong>${esc(kinds[v.kind] || v.kind)} ${esc(ago(v.createdAt))}</strong>
      <span class="meta">${esc(new Date(v.createdAt).toLocaleString('en-NZ'))}${v.createdBy ? ` · ${esc(v.createdBy)}` : ''}</span>
      ${v.note ? `<span>${esc(v.note)}</span>` : ''}
      <div class="acts"><button class="btn btn--sm" type="button" data-pv="${v.id}">Preview</button><button class="btn btn--sm" type="button" data-rs="${v.id}">Restore into draft</button></div></div>`).join('');
    box.querySelectorAll('[data-pv]').forEach((b) => b.onclick = () => previewVersion(Number(b.dataset.pv)));
    box.querySelectorAll('[data-rs]').forEach((b) => b.onclick = () => restoreVersion(Number(b.dataset.rs)));
  } catch (e) {
    box.innerHTML = `<p class="help">Couldn't load history: ${esc(e.message)}</p>`;
  }
}

async function previewVersion(id) {
  try {
    const r = await api('GET', { action: 'version', id });
    S.previewing = r.version;
    notice('info', `Previewing the version from ${esc(new Date(r.version.createdAt).toLocaleString('en-NZ'))}. <button class="btn btn--sm" type="button" id="pv-back2">Back to editing</button>`);
    $('#pv-back2').onclick = endPreview;
    paint();
    renderPanel();
  } catch (e) { toast(esc(e.message)); }
}

function endPreview() {
  S.previewing = null;
  notice(null);
  paint();
  setTab('history');
}

async function restoreVersion(id) {
  if (!confirm('Replace the current draft with this version? You can undo this with the Undo button.')) return;
  await flushSave();
  try {
    takeSnapshot();
    const r = await api('POST', {}, { action: 'restore', slug: S.slug, rev: S.rev, versionId: id });
    S.undo.push(S.snap);
    S.data = normalizeProgram(r.draft);
    S.snap = JSON.stringify(S.data);
    S.rev = r.rev;
    if (S.status === 'live') S.status = 'changes';
    S.previewing = null;
    notice(null);
    paint();
    setTab('edit');
    updateBar();
    toast('Restored into the draft. Publish when you’re ready.');
  } catch (e) { toast(esc(e.message)); }
}

// ─── publishing ─────────────────────────────────────────────────────────────

function selectPath(path) {
  // Select whatever on the page holds this value (for the "Show me" links).
  const parts = path.split('.');
  let sel = null;
  for (let n = parts.length - 1; n > 0 && !sel; n--) {
    const lp = parts.slice(0, n).join('.');
    if (SCHEMA.lists[lp] && /^\d+$/.test(parts[n])) sel = { kind: 'item', path: `${lp}.${parts[n]}` };
  }
  if (!sel && (parts[0] === 'hero' || parts[0] === 'facts')) sel = { kind: 'group', key: parts[0] };
  if (!sel && SECTIONS.some((s) => s.key === parts[0])) sel = { kind: 'section', key: parts[0] };
  if (!sel) { S.focusField = path; setTab('page'); return; }
  select(sel, path);
  setTimeout(() => selElement()?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}

export function publishChecks(p) {
  const out = [];
  const visible = (key) => (p.layout || []).find((l) => l.key === key)?.show !== false;
  const ph = findPlaceholders(p).filter((x) => {
    const top = x.path.split('.')[0];
    return !SECTIONS.some((s) => s.key === top) || visible(top);
  }).filter((x) => !/^seo\./.test(x.path));
  if (ph.length) out.push({ level: 'bad', text: `${ph.length} placeholder${ph.length === 1 ? '' : 's'} in [square brackets] still showing. Fill them in or hide the section.`, items: ph.slice(0, 6) });
  if (!(Number(p.facts?.tuition) > 0)) out.push({ level: 'bad', text: 'Tuition is not set.', items: [{ path: 'facts.tuition', text: 'Tuition' }] });
  const sessions = p.dates?.sessions || [];
  if (visible('dates') && !sessions.length) out.push({ level: 'warn', text: 'No start dates listed.' });
  sessions.forEach((s, i) => { if (!s.start || !s.end) out.push({ level: 'bad', text: `Start date ${i + 1} is missing a start or end date.`, items: [{ path: `dates.sessions.${i}.start`, text: 'Dates' }] }); });
  (p.hero?.widgets || []).forEach((w, i) => {
    if (!parseWidget(w)) out.push({ level: 'bad', text: `Review widget ${i + 1} (${w.type || 'unknown'}) has no valid embed code. Paste it again or delete the widget.`, items: [{ path: `hero.widgets.${i}.code`, text: `${w.type || 'Widget'} embed code` }] });
  });
  const missingAlt = [];
  (function walk(v, path) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}.${i}`));
    if (v && typeof v === 'object') {
      if (v.image && 'imageAlt' in v && !String(v.imageAlt || '').trim()) missingAlt.push({ path: `${path}.imageAlt`, text: 'Photo with no description' });
      for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') walk(v[k], path ? `${path}.${k}` : k);
    }
  })(p, '');
  if (missingAlt.length) out.push({ level: 'warn', text: `${missingAlt.length} photo${missingAlt.length === 1 ? ' has' : 's have'} no description (helps Google and screen readers).`, items: missingAlt.slice(0, 4) });
  const d = String(p.seo?.description || '');
  if (d.length < 70) out.push({ level: 'warn', text: 'The search result description is short. Aim for 140–160 characters (Page settings).' });
  if (!out.length) out.push({ level: 'ok', text: 'Everything looks good.' });
  return out;
}

$('#btn-publish').onclick = async () => {
  stopInline();
  await flushSave();
  const checks = publishChecks(S.data);
  const blocked = checks.some((c) => c.level === 'bad');
  $('#pub-checks').innerHTML = checks.map((c, ci) => `<div class="check"><span class="dot ${c.level}" aria-hidden="true"></span><div>${esc(c.text)}${
    c.items ? `<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px">${c.items.map((it, ii) => `<a href="#" data-show="${ci}:${ii}">Show me: ${esc(String(it.text).slice(0, 60))}</a>`).join('')}</div>` : ''}</div></div>`).join('') +
    (!S.user?.canPublish ? `<p class="notice notice--warn" style="margin-top:12px">You can edit and save drafts. Publishing needs someone with the admin, outreach or programs role.</p>` : '');
  $$('#pub-checks [data-show]').forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    const [ci, ii] = a.dataset.show.split(':').map(Number);
    $('#dlg-pub').close();
    selectPath(checks[ci].items[ii].path);
  });
  $('#pub-go').disabled = blocked || !S.user?.canPublish || S.dirty || S.saving;
  $('#pub-go').textContent = blocked ? 'Fix the red items first' : 'Publish now';
  $('#pub-err').classList.add('hidden');
  $('#pub-note').value = '';
  $('#dlg-pub').showModal();
};

$('#form-pub').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return;
  e.preventDefault();
  const go = $('#pub-go');
  go.disabled = true;
  go.textContent = 'Publishing…';
  try {
    const r = await api('POST', {}, { action: 'publish', slug: S.slug, rev: S.rev, note: $('#pub-note').value });
    S.status = 'live';
    S.publishedRev = r.publishedRev;
    updateBar();
    $('#dlg-pub').close();
    if (r.build?.triggered) toast(`Published. The live page updates in about a minute. <a href="${esc(LIVE_BASE + S.slug)}" target="_blank" rel="noopener">View live ↗</a>`, 8000);
    else notice('warn', `Published, but the public site wasn't rebuilt: ${esc(r.build?.message || 'unknown reason')} Tell Jake.`);
  } catch (e2) {
    $('#pub-err').textContent = e2.message;
    $('#pub-err').classList.remove('hidden');
    go.disabled = false;
    go.textContent = 'Publish now';
  }
});

async function unpublish() {
  if (!confirm('Take this page offline? The old pacificdiscovery.org page comes back at this address within a minute.')) return;
  try {
    await api('POST', {}, { action: 'unpublish', slug: S.slug });
    S.status = 'draft';
    updateBar();
    renderPanel();
    toast('Page taken offline.');
  } catch (e) { toast(esc(e.message)); }
}

async function archive() {
  if (!confirm('Archive this page? It disappears from the list (tick "Show archived" to find it again).')) return;
  try {
    await flushSave();
    await api('POST', {}, { action: 'archive', slug: S.slug });
    S.dirty = false;
    location.hash = '';
  } catch (e) { toast(esc(e.message)); }
}

// ─── misc wiring ────────────────────────────────────────────────────────────

$('#btn-back').onclick = () => { location.hash = ''; };
$('#dev-desktop').onclick = () => setDevice(false);
$('#dev-mobile').onclick = () => setDevice(true);
function setDevice(mobile) {
  $('#canvas').classList.toggle('mobile', mobile);
  $('#dev-desktop').setAttribute('aria-pressed', String(!mobile));
  $('#dev-mobile').setAttribute('aria-pressed', String(mobile));
}

// Warn (admins only) when the editor's pinned template differs from the one the
// public site is building with. Compares text only — nothing remote is executed.
let driftMsg = '';
async function checkTemplateDrift() {
  if (!S.user || !S.user.canPublish) return;
  try {
    const [mine, theirs] = await Promise.all([
      fetch('/program-pages/template/render.mjs', { credentials: 'include' }).then((r) => r.text()),
      fetch(`${PROGRAM_SITE}/_pd/render.mjs`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)),
    ]);
    driftMsg = theirs && theirs !== mine
      ? 'The public site and this editor are using different versions of the page template. Run <code>npm run sync:template</code> in pd-dashboard (or copy src/render.mjs across) and deploy, so the preview matches the live page.'
      : '';
  } catch { driftMsg = ''; }
  if (S.tab === 'page') showDrift();
}
function showDrift() {
  const el = $('#drift');
  if (el) el.innerHTML = driftMsg ? `<p class="notice notice--info" style="margin-top:16px;border-radius:8px">${driftMsg}</p>` : '';
}

// Expose for the smoke test.
window.__pdp = { S, publishChecks, dateRange };

route();
