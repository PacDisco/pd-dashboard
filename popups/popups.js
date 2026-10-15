// popups/popups.js — the Website Popups designer.
//
// Design popups for pacificdiscovery.org, preview them exactly as visitors
// will see them (the preview runs the same script the website loads), and
// choose where and when they appear. Saving makes changes live; the website
// picks them up within about a minute.
//
// API: /api/popups (see netlify/functions/popups.mjs).

const API = '/api/popups';
const RUNTIME = '/api/popup-embed?runtime=1';
const ACCENTS = [['#F15B39', 'Orange'], ['#288195', 'Teal'], ['#55bbd2', 'Topaz'], ['#81c243', 'Green'], ['#2f2f2f', 'Charcoal']];
const LAYOUTS = [
  ['modal', 'Centre popup', '<rect x="1" y="1" width="54" height="38" rx="4" fill="#e9eef0"/><rect x="14" y="8" width="28" height="24" rx="3" fill="#fff" stroke="#288195"/>'],
  ['slide', 'Corner slide-in', '<rect x="1" y="1" width="54" height="38" rx="4" fill="#e9eef0"/><rect x="32" y="16" width="20" height="20" rx="3" fill="#fff" stroke="#288195"/>'],
  ['bar', 'Bottom bar', '<rect x="1" y="1" width="54" height="38" rx="4" fill="#e9eef0"/><rect x="1" y="28" width="54" height="11" rx="2" fill="#fff" stroke="#288195"/>'],
];

const S = { doc: { rev: 0, popups: [] }, stats: {}, blank: null, fieldDefs: [], embedUrl: '', cur: null, tab: 'content', dirty: false, props: null, propsErr: '', programs: null, saving: false, gmail: null };
window.__popups = { S };

// ─── helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const cur = () => S.doc.popups.find((p) => p.id === S.cur);
const def = (key) => S.fieldDefs.find((d) => d.key === key) || {};

class ApiError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; } }
async function api(method, params = {}, body, raw) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`, {
    method,
    credentials: 'include',
    headers: raw ? { 'Content-Type': raw.type } : body ? { 'Content-Type': 'application/json' } : {},
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function toast(msg, ms = 3800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function statusOf(p) {
  if (!p.enabled) return ['off', 'Off'];
  const t = new Date().toISOString().slice(0, 10);
  if (p.ends && t > p.ends) return ['off', 'Ended'];
  if (p.starts && t < p.starts) return ['sched', `Starts ${p.starts}`];
  return ['on', 'On'];
}
function pagesSummary(p) {
  if (p.pages.mode === 'all') return 'All pages';
  const n = p.pages.rules.length;
  return `${p.pages.mode === 'include' ? 'Only' : 'All except'} ${n} page${n === 1 ? '' : 's'}`;
}
function triggerSummary(t) {
  const parts = [];
  if (t.delay > 0) parts.push(`after ${t.delay}s`);
  if (t.scroll > 0) parts.push(`at ${t.scroll}% scroll`);
  if (t.exit) parts.push('on exit');
  return parts.length ? parts.join(' or ') : 'straight away';
}

/** Same shape /api/popup-embed sends the website (popupConfig in popups-core.mjs). */
function toPublic(p) {
  const link = isLink(p);
  return {
    ...p,
    imagePos: p.image ? p.imagePos : 'none',
    privacy: link ? '' : p.privacy,
    fields: link ? [] : p.fields.filter((f) => f.on).map((f) => ({ key: f.key, label: f.label, type: def(f.key).type, required: f.required, autocomplete: def(f.key).autocomplete || '', ...(f.options ? { options: f.options } : {}) })),
  };
}

/** A link popup has no form: its button just opens a page. */
function isLink(p) { return p && p.action === 'link'; }
function ensureLink(p) { if (!p.link) p.link = { url: '', newTab: false }; return p.link; }

function markDirty() {
  S.dirty = true;
  $('ed-save').textContent = 'Unsaved changes';
  $('ed-save').className = 'save-state';
  schedulePreview();
}
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ─── load + save ──────────────────────────────────────────────────────────

async function load() {
  try {
    const d = await api('GET', { action: 'list' });
    S.doc = { rev: d.rev, popups: d.popups };
    S.stats = d.stats || {};
    S.blank = d.blank;
    S.fieldDefs = d.fieldDefs || [];
    S.embedUrl = d.embedUrl;
    $('gtm-code').textContent = `<script src="${d.embedUrl}" async></script>`;
  } catch (e) {
    $('list-error').textContent = e.status === 401 ? 'Please sign in to the dashboard first.' : `Couldn't load popups: ${e.message}`;
    $('list-error').classList.remove('hidden');
    $('list-body').innerHTML = '';
    return;
  }
  route();
}

async function save(quiet) {
  if (S.saving) return false;
  S.saving = true;
  $('btn-save').disabled = true;
  $('ed-save').textContent = 'Saving…';
  try {
    const r = await api('POST', {}, { action: 'save', rev: S.doc.rev, popups: S.doc.popups });
    S.doc = { rev: r.rev, popups: r.popups };
    S.dirty = false;
    $('ed-save').textContent = 'Saved · live on the site within a minute';
    $('ed-save').className = 'save-state';
    $('ed-notice').classList.add('hidden');
    if (!quiet) toast('Saved');
    return true;
  } catch (e) {
    $('ed-save').textContent = 'Not saved';
    $('ed-save').className = 'save-state err';
    const n = $('ed-notice');
    n.className = 'notice notice--bad';
    n.textContent = e.message;
    if (!$('view-list').classList.contains('hidden')) toast(e.message, 6000);
    return false;
  } finally {
    S.saving = false;
    $('btn-save').disabled = false;
  }
}

// ─── list view ────────────────────────────────────────────────────────────

function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  const gm = h.get('gmail');
  if (gm) {
    const msgs = { connected: 'Mailbox connected — popup notifications will send from it.', cancelled: 'Gmail connection cancelled.', expired: 'That took too long — please try connecting again.', error: `Couldn’t connect Gmail${h.get('msg') ? `: ${h.get('msg')}` : '.'}` };
    toast(msgs[gm] || msgs.error, 7000);
    let back = '';
    try { back = sessionStorage.getItem('pdpop-return') || ''; sessionStorage.removeItem('pdpop-return'); } catch { /* ignore */ }
    S.gmail = null;
    if (back) { S.tab = 'form'; document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tab === 'form'))); }
    history.replaceState(null, '', back ? `#edit=${back}` : location.pathname);
  }
  const id = new URLSearchParams(location.hash.slice(1)).get('edit');
  if (id && S.doc.popups.some((p) => p.id === id)) openEditor(id);
  else showList();
}
window.addEventListener('hashchange', () => { if (!S.dirty) route(); });

function showList() {
  S.cur = null;
  $('view-editor').classList.add('hidden');
  $('view-list').classList.remove('hidden');
  document.title = 'Website Popups — Pacific Discovery';
  const box = $('list-body');
  if (!S.doc.popups.length) {
    box.innerHTML = `<div class="empty"><h2 class="serif" style="font-size:24px">No popups yet</h2><p style="margin:0;max-width:440px">Make one to collect enquiries on the website. Sign-ups go straight into HubSpot as new Pacific Discovery leads.</p><button class="btn btn--primary" type="button" data-new>+ New popup</button></div>`;
    $('setup').open = true;
  } else {
    box.innerHTML = `<table class="list"><thead><tr><th>Popup</th><th>Status</th><th>Shows on</th><th>Sign-ups</th><th></th></tr></thead><tbody>${S.doc.popups.map((p, i) => {
      const [k, label] = statusOf(p);
      const st = S.stats[p.id];
      return `<tr data-id="${esc(p.id)}">
        <td><div class="nm">${esc(p.name)}</div><div class="sl">${esc(LAYOUTS.find((l) => l[0] === p.layout)[1])}${isLink(p) ? ' · link, no form' : ''} · ${esc(triggerSummary(p.trigger))}</div></td>
        <td><label class="switch"><input type="checkbox" data-toggle="${esc(p.id)}"${p.enabled ? ' checked' : ''} aria-label="Show ${esc(p.name)} on the website"><span class="tr"></span></label> <span class="chip chip--${k}">${esc(label)}</span></td>
        <td>${esc(pagesSummary(p))}${p.devices !== 'all' ? `<div class="sl">${p.devices === 'mobile' ? 'Phones only' : 'Desktop only'}</div>` : ''}</td>
        <td>${isLink(p) ? '<span class="sl" title="Link popups don’t collect sign-ups. Clicks are tracked in Google Analytics as pd_popup_click.">link</span>' : st ? `<b>${st.submits}</b><div class="sl">last ${new Date(st.last).toLocaleDateString()}</div>` : '<span class="sl">—</span>'}</td>
        <td><div class="acts">
          <button class="btn btn--sm" type="button" data-up="${i}"${i === 0 ? ' disabled' : ''} title="Higher priority (one popup shows per page)">↑</button>
          <button class="btn btn--sm" type="button" data-edit="${esc(p.id)}">Edit</button>
          <button class="btn btn--sm" type="button" data-dup="${esc(p.id)}">Duplicate</button>
          <button class="btn btn--sm btn--danger" type="button" data-del="${esc(p.id)}">Delete</button></div></td></tr>`;
    }).join('')}</tbody></table><p class="help" style="margin-top:8px">If more than one popup could show on a page, the one highest in this list wins. Only one popup appears per page view.</p>`;
  }
  box.querySelectorAll('[data-new]').forEach((b) => b.onclick = newPopup);
  box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => { location.hash = `edit=${b.dataset.edit}`; });
  box.querySelectorAll('[data-dup]').forEach((b) => b.onclick = async () => {
    const src = S.doc.popups.find((p) => p.id === b.dataset.dup);
    const copy = { ...clone(src), id: newId(), name: `${src.name} (copy)`, enabled: false };
    S.doc.popups.splice(S.doc.popups.indexOf(src) + 1, 0, copy);
    if (await save(true)) showList();
  });
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const p = S.doc.popups.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete “${p.name}”? It disappears from the website straight away.`)) return;
    const before = clone(S.doc.popups);
    S.doc.popups = S.doc.popups.filter((x) => x.id !== p.id);
    if (await save(true)) { toast('Deleted'); showList(); } else S.doc.popups = before;
  });
  box.querySelectorAll('[data-up]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.up);
    const [p] = S.doc.popups.splice(i, 1);
    S.doc.popups.splice(i - 1, 0, p);
    if (await save(true)) showList();
  });
  box.querySelectorAll('[data-toggle]').forEach((c) => c.onchange = async () => {
    const p = S.doc.popups.find((x) => x.id === c.dataset.toggle);
    p.enabled = c.checked;
    if (await save(true)) { toast(c.checked ? `“${p.name}” is on` : `“${p.name}” is off`); showList(); }
    else { p.enabled = !c.checked; showList(); }
  });
}

function newId() { return 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

async function newPopup() {
  const p = { ...clone(S.blank), id: newId(), name: `Popup ${S.doc.popups.length + 1}`, enabled: false };
  S.doc.popups.push(p);
  if (await save(true)) location.hash = `edit=${p.id}`;
  else S.doc.popups.pop();
}
$('btn-new').onclick = newPopup;

// ─── editor ───────────────────────────────────────────────────────────────

function openEditor(id) {
  S.cur = id;
  const p = cur();
  $('view-list').classList.add('hidden');
  $('view-editor').classList.remove('hidden');
  $('ed-name').textContent = p.name;
  $('ed-save').textContent = '';
  $('ed-notice').classList.add('hidden');
  document.title = `${p.name} — Website Popups`;
  syncToggle();
  renderPanel();
  loadPreview();
  if (!S.props) loadProps();
  if (!S.gmail) loadGmail();
}

function syncToggle() {
  const p = cur();
  $('ed-on').checked = p.enabled;
  const [, label] = statusOf(p);
  $('ed-on-lbl').textContent = p.enabled ? label : 'Off';
}

$('btn-back').onclick = () => {
  if (S.dirty && !confirm('You have unsaved changes. Leave without saving?')) return;
  if (S.dirty) { S.dirty = false; load(); }
  location.hash = '';
  showList();
};
$('btn-save').onclick = () => save();
$('ed-on').onchange = async () => {
  const p = cur();
  p.enabled = $('ed-on').checked;
  if (await save(true)) toast(p.enabled ? 'Popup is on — it shows on the website within a minute' : 'Popup is off');
  else p.enabled = !p.enabled;
  syncToggle();
};
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && S.cur) { e.preventDefault(); save(); }
});

$('dev-desktop').onclick = () => setDevice(false);
$('dev-mobile').onclick = () => setDevice(true);
function setDevice(m) {
  $('canvas').classList.toggle('mobile', m);
  $('dev-desktop').setAttribute('aria-pressed', String(!m));
  $('dev-mobile').setAttribute('aria-pressed', String(m));
  setTimeout(renderPreview, 260);
}
$('btn-replay').onclick = () => renderPreview();

document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.onclick = () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderPanel();
});

// ─── preview ──────────────────────────────────────────────────────────────

const FAKE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;font-family:Poppins,sans-serif;color:#4a4a4a;background:#fff}header{height:64px;display:flex;align-items:center;padding:0 24px;border-bottom:1px solid #eee;font-weight:700;color:#288195;gap:24px}header span{font-weight:500;color:#999;font-size:13px}
.hero{height:300px;background:linear-gradient(120deg,#7fcde0,#288195);display:flex;align-items:flex-end;padding:28px}.hero h1{font-family:'DM Serif Display',serif;color:#fff;font-weight:400;font-size:40px;margin:0}
.wrap{max-width:900px;margin:0 auto;padding:28px 24px}.ln{height:12px;background:#eef1f2;border-radius:6px;margin:12px 0}</style></head>
<body><header>PACIFIC DISCOVERY <span>Programs</span><span>About</span><span>Apply</span></header><div class="hero"><h1>Your website page</h1></div>
<div class="wrap">${'<div class="ln"></div>'.repeat(14)}</div><script src="${RUNTIME}"></script></body></html>`;

function loadPreview() {
  const f = $('frame');
  f.onload = () => renderPreview();
  f.srcdoc = FAKE_PAGE;
}
let _pt;
function schedulePreview() { clearTimeout(_pt); _pt = setTimeout(renderPreview, 250); }
function renderPreview() {
  const w = $('frame').contentWindow;
  if (!w || !w.PDPopupRuntime || !cur()) return;
  w.document.querySelectorAll('[data-pd-popup]').forEach((n) => n.remove());
  w.PDPopupRuntime(w, w.document, [toPublic(cur())], { preview: true });
}

// ─── panels ───────────────────────────────────────────────────────────────

function fText(path, label, { help = '', multiline = false, max = 200, placeholder = '' } = {}) {
  const v = getPath(cur(), path) ?? '';
  const id = `f-${path.replace(/\W/g, '_')}`;
  const ctl = multiline
    ? `<textarea id="${id}" data-path="${esc(path)}" maxlength="${max}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`
    : `<input type="text" id="${id}" data-path="${esc(path)}" maxlength="${max}" value="${esc(v)}" placeholder="${esc(placeholder)}">`;
  return `<div class="field"><label for="${id}">${esc(label)}</label>${ctl}${help ? `<span class="help">${help}</span>` : ''}</div>`;
}
function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const t = ks.reduce((a, k) => a[k], o);
  t[last] = v;
}

function renderPanel() {
  const p = cur();
  if (!p) return;
  const box = $('panel');
  if (S.tab === 'content') box.innerHTML = contentPanel(p);
  else if (S.tab === 'form') box.innerHTML = formPanel(p);
  else if (S.tab === 'where') box.innerHTML = wherePanel(p);
  else box.innerHTML = stylePanel(p);
  wirePanel(box);
  if (S.tab === 'where' && S.programs === null) loadPrograms();
}

function contentPanel(p) {
  const link = isLink(p);
  const l = ensureLink(p);
  return fText('name', 'Popup name (only you see this)', { max: 80 }) +
    `<div class="field"><span class="lbl">When they click the button</span><div class="seg" role="group" aria-label="What the button does">${[['form', 'Collect their details'], ['link', 'Just open a link']].map(([v, t]) => `<button type="button" data-action="${v}" aria-pressed="${(p.action || 'form') === v}">${t}</button>`).join('')}</div>
      <span class="help">${link ? 'No form and no email: the popup is a message with a button that goes to the link below. Nothing is sent to HubSpot.' : 'A short form. Sign-ups go into HubSpot, and can email the team (Form tab).'}</span></div>` +
    fText('eyebrow', 'Small heading (optional)', { max: 80 }) +
    fText('headline', 'Headline', { max: 160 }) +
    fText('body', 'Text', { multiline: true, max: 600 }) +
    fText('button', 'Button text', { max: 60, placeholder: link ? 'e.g. See the early-bird offer' : '' }) +
    (link
      ? `<div class="field"><label for="f-link_url">Button link</label><input type="url" id="f-link_url" data-path="link.url" maxlength="1000" value="${esc(l.url)}" placeholder="https://www.pacificdiscovery.org/apply">
          ${l.url && !/^(https?:\/\/|\/(?!\/))/i.test(l.url) ? '<span class="help" style="color:var(--bad)">Use a full https:// address, or a page on the site starting with /.</span>' : '<span class="help">A full address (https://…), or a page on the website starting with /, e.g. <code>/apply</code>.</span>'}</div>
        <label class="req" style="font-size:13px;margin:-4px 0 12px"><input type="checkbox" id="link-newtab"${l.newTab ? ' checked' : ''}> Open in a new tab</label>`
      : fText('privacy', 'Small print under the button', { multiline: true, max: 300 })) +
    `<h3 class="sub">Image</h3>${imagePanel(p)}` + (link ? '' :
    `<h3 class="sub">After they sign up</h3>` +
    fText('success.headline', 'Thank-you headline', { max: 160 }) +
    fText('success.body', 'Thank-you text', { multiline: true, max: 600 }) +
    `<div class="two">${fText('success.linkText', 'Button (optional)', { max: 60, placeholder: 'e.g. Book a call' })}${fText('success.linkUrl', 'Button link', { max: 500, placeholder: 'https://…' })}</div>`);
}

function imagePanel(p) {
  return `<div class="imgbox">${p.image ? `<img src="${esc(p.image)}" alt="">` : '<div class="none">No image</div>'}</div>
    <div class="imgacts"><label class="btn btn--sm">Upload image<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="img-file" hidden></label>${p.image ? '<button class="btn btn--sm btn--danger" type="button" id="img-clear">Remove</button>' : ''}</div>
    <div class="field" style="margin-top:10px"><label for="img-url">…or paste an image link</label><input type="url" id="img-url" value="${esc(p.image)}" placeholder="https://www.pacificdiscovery.org/library/images/…"></div>
    ${fText('imageAlt', 'Describe the image (for screen readers)', { max: 200 })}
    <div class="field"><span class="lbl">Image position</span><div class="seg" role="group">${[['side', 'Beside the form'], ['top', 'Above'], ['none', 'Hide']].map(([v, l]) => `<button type="button" data-imgpos="${v}" aria-pressed="${p.imagePos === v}">${l}</button>`).join('')}</div><span class="help">“Beside” applies to the centre popup on desktop; phones and slide-ins show it above.</span></div>`;
}

function propSelect(f) {
  if (!S.props) {
    return `<div class="field"><label>HubSpot property</label><input type="text" data-fprop="${f.key}" value="${esc(f.property)}" placeholder="internal name, e.g. program_interest"><span class="help">${S.propsErr ? esc(S.propsErr) : 'Loading HubSpot properties…'}</span></div>`;
  }
  const opts = S.props.map((pr) => `<option value="${esc(pr.name)}"${pr.name === f.property ? ' selected' : ''}>${esc(pr.label)} (${esc(pr.name)})</option>`).join('');
  const missing = f.property && !S.props.some((pr) => pr.name === f.property);
  return `<div class="field"><label for="prop-${f.key}">Save to HubSpot property</label><select id="prop-${f.key}" data-fprop="${f.key}"><option value="">— Don't save to HubSpot —</option>${missing ? `<option value="${esc(f.property)}" selected>${esc(f.property)} (not found in HubSpot)</option>` : ''}${opts}</select>${missing ? '<span class="help" style="color:var(--bad)">This property doesn’t exist in HubSpot, so this answer would be left out.</span>' : ''}</div>`;
}

function formPanel(p) {
  if (isLink(p)) {
    return `<div class="notice notice--info">This popup just opens a link, so it has no form and sends no emails.</div>
      <p class="help">To collect details instead, go to <b>Content</b> and choose <b>Collect their details</b>. The form you set up before is kept.</p>`;
  }
  return `<p class="help" style="margin-top:0">Every sign-up is created or updated in HubSpot with <b>company_tag = Pacific Discovery</b> and <b>Lead status = New lead</b>, and lifecycle stage <b>Lead</b> if they're not already further along. A note on the contact records the popup and page.</p>` +
    p.fields.map((f, i) => {
      const d = def(f.key);
      const isSel = d.type === 'select';
      return `<div class="fieldrow${f.on ? '' : ' off'}">
        <div class="top">
          <label class="switch"><input type="checkbox" data-fon="${f.key}"${f.on ? ' checked' : ''}${d.locked ? ' disabled' : ''} aria-label="Ask for ${esc(d.label)}"><span class="tr"></span></label>
          <span class="t">${esc(f.label)}</span>
          ${f.on ? `<label class="req"><input type="checkbox" data-freq="${f.key}"${f.required ? ' checked' : ''}${d.locked ? ' disabled' : ''}> Required</label>` : ''}
          <button class="mv" type="button" data-fmv="${i}" data-dir="-1"${i === 0 ? ' disabled' : ''} aria-label="Move up">↑</button>
          <button class="mv" type="button" data-fmv="${i}" data-dir="1"${i === p.fields.length - 1 ? ' disabled' : ''} aria-label="Move down">↓</button>
        </div>
        <div class="more">
          <div class="field"><label for="fl-${f.key}">Label on the form</label><input type="text" id="fl-${f.key}" data-flabel="${f.key}" value="${esc(f.label)}" maxlength="120"></div>
          ${f.key === 'email' ? '<p class="help">Email is always asked: HubSpot matches contacts by email.</p>' : propSelect(f)}
          ${isSel ? `<div class="field"><label for="fo-${f.key}">Choices (one per line)</label><textarea id="fo-${f.key}" data-fopts="${f.key}" placeholder="Label | value">${esc((f.options || []).map((o) => (o.label === o.value ? o.label : `${o.label} | ${o.value}`)).join('\n'))}</textarea>
            <span class="help">Write “Label | value” when HubSpot stores a different value from what visitors see.</span>
            ${f.property ? `<div class="quick"><button class="btn btn--sm" type="button" data-fload="${f.key}">Use the choices from HubSpot</button></div>` : ''}</div>` : ''}
        </div></div>`;
    }).join('') + notifyPanel(p);
}

function notifyPanel(p) {
  const g = S.gmail;
  const bad = p.notify.emails.filter((e) => !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e));
  let conn;
  if (!g) conn = '<p class="help">Checking the email connection…</p>';
  else if (!g.configured) conn = '<div class="notice notice--bad">The dashboard’s Google sign-in isn’t set up (GOOGLE_OAUTH_CLIENT_ID / SECRET), so emails can’t be sent yet.</div>';
  else if (g.connected) conn = `<div class="gmail ok"><b>Sending from ${esc(g.email || 'the connected mailbox')}</b><span class="help">Connected${g.by ? ` by ${esc(g.by)}` : ''}${g.at ? ` · ${new Date(g.at).toLocaleDateString()}` : ''}</span>
      ${g.lastError ? `<span class="help" style="color:var(--bad)">Last send failed: ${esc(g.lastError)}</span>` : ''}
      <div class="quick"><button class="btn btn--sm" type="button" id="gm-test"${p.notify.emails.length ? '' : ' disabled'}>Send a test email</button><button class="btn btn--sm" type="button" id="gm-connect">Use a different mailbox</button><button class="btn btn--sm btn--danger" type="button" id="gm-off">Disconnect</button></div></div>`;
  else conn = `<div class="gmail"><b>No mailbox connected yet</b><span class="help">Connect the Google Workspace address the emails should come from (e.g. info@pacificdiscovery.org). It only gets permission to <i>send</i>, not read.</span>
      <div class="quick"><button class="btn btn--sm btn--primary" type="button" id="gm-connect">Connect Gmail</button></div>
      <span class="help">First time? Add <code>${esc(g.redirectUri)}</code> as an authorised redirect URI on the dashboard’s Google OAuth client.</span></div>`;
  return `<h3 class="sub">Email the team</h3>
    <div class="field"><label for="notify-emails">When someone signs up, email</label><textarea id="notify-emails" placeholder="admissions@pacificdiscovery.org" style="min-height:64px">${esc(p.notify.emails.join('\n'))}</textarea>
    <span class="help">One address per line (up to 10). Leave empty for no emails. Each email has their details, the page, and a link to the contact in HubSpot. Replying goes straight to them.</span>
    ${bad.length ? `<span class="help" style="color:var(--bad)">Not a valid address: ${bad.map(esc).join(', ')}</span>` : ''}</div>
    ${p.notify.emails.length || g?.connected ? conn : ''}`;
}

function wherePanel(p) {
  const progs = (S.programs || []).filter((x) => x.status !== 'archived');
  return `<h3 class="sub" style="margin-top:0">Pages</h3>
    <div class="radios">${[['all', 'Every page'], ['include', 'Only on these pages'], ['exclude', 'Every page except these']].map(([v, l]) => `<label><input type="radio" name="pmode" value="${v}"${p.pages.mode === v ? ' checked' : ''}> ${l}</label>`).join('')}</div>
    ${p.pages.mode !== 'all' ? `<div class="field" style="margin-top:10px"><label for="prules">Pages (one per line)</label><textarea id="prules" placeholder="/programs/south-america-gap-semester&#10;/programs/*">${esc(p.pages.rules.join('\n'))}</textarea>
      <span class="help">Paste a page address, or use * for “anything”: <code>/programs/*</code> is every program page. <code>/</code> is the homepage.</span>
      <div class="quick">
        <button class="btn btn--sm" type="button" data-addrule="/">+ Homepage</button>
        <button class="btn btn--sm" type="button" data-addrule="/programs/*">+ All program pages</button>
        ${progs.length ? `<select id="addprog" class="btn btn--sm" style="max-width:220px"><option value="">+ A program page…</option>${progs.map((x) => `<option value="/programs/${esc(x.slug)}">${esc(x.name)}</option>`).join('')}</select>` : ''}
      </div></div>` : ''}
    <h3 class="sub">Devices</h3>
    <div class="radios">${[['all', 'Desktop and phones'], ['desktop', 'Desktop only'], ['mobile', 'Phones only']].map(([v, l]) => `<label><input type="radio" name="dev" value="${v}"${p.devices === v ? ' checked' : ''}> ${l}</label>`).join('')}</div>
    <h3 class="sub">When it appears</h3>
    <p class="help" style="margin-top:-4px">It appears as soon as any one of these happens.</p>
    <div class="two"><div class="field"><label for="t-delay">After (seconds on the page)</label><input type="number" id="t-delay" min="0" max="600" value="${p.trigger.delay}"><span class="help">0 = don't use</span></div>
    <div class="field"><label for="t-scroll">After scrolling (% of page)</label><input type="number" id="t-scroll" min="0" max="100" value="${p.trigger.scroll}"><span class="help">0 = don't use</span></div></div>
    <label class="req" style="font-size:13px;margin-bottom:6px"><input type="checkbox" id="t-exit"${p.trigger.exit ? ' checked' : ''}> When they move to leave the page (desktop)</label>
    <p class="help">With nothing set, it appears straight away.</p>
    <h3 class="sub">How often</h3>
    <div class="field"><label for="hide-days">If they close it, don't show it again for (days)</label><input type="number" id="hide-days" min="0" max="365" value="${p.frequency.hideDays}"><span class="help">Once someone signs up, they never see this popup again.</span></div>
    <h3 class="sub">Schedule (optional)</h3>
    <div class="two"><div class="field"><label for="d-start">Start</label><input type="date" id="d-start" value="${esc(p.starts)}"></div><div class="field"><label for="d-end">End</label><input type="date" id="d-end" value="${esc(p.ends)}"></div></div>
    <p class="help">Handy for promotions, e.g. an early-bird offer that ends on a date. It still needs to be switched on.</p>`;
}

function stylePanel(p) {
  return `<div class="field"><span class="lbl">Layout</span><div class="tiles">${LAYOUTS.map(([v, l, svg]) => `<button type="button" class="tile" data-layout="${v}" aria-pressed="${p.layout === v}"><svg viewBox="0 0 56 40" aria-hidden="true">${svg}</svg>${l}</button>`).join('')}</div>
    <span class="help">Centre popups dim the page and ask for attention. Slide-ins and bars are gentler and let people keep reading.</span></div>
    <div class="field"><span class="lbl">Button colour</span><div class="swatches">${ACCENTS.map(([c, n]) => `<button type="button" class="swatch" data-accent="${c}" style="background:${c}" aria-label="${n}" aria-pressed="${p.accent.toLowerCase() === c.toLowerCase()}"></button>`).join('')}
    <input type="color" id="accent-custom" value="${esc(p.accent)}" aria-label="Custom colour" style="width:36px;height:32px;border:0;background:none;padding:0"></div></div>`;
}

function wirePanel(box) {
  const p = cur();
  box.querySelectorAll('[data-path]').forEach((el) => el.addEventListener('input', () => {
    setPath(p, el.dataset.path, el.value);
    if (el.dataset.path === 'name') { $('ed-name').textContent = el.value; }
    markDirty();
  }));
  // image
  const fileIn = box.querySelector('#img-file');
  if (fileIn) fileIn.onchange = () => fileIn.files[0] && uploadImage(fileIn.files[0]);
  const urlIn = box.querySelector('#img-url');
  if (urlIn) urlIn.addEventListener('change', () => { p.image = urlIn.value.trim(); markDirty(); renderPanel(); });
  const clr = box.querySelector('#img-clear');
  if (clr) clr.onclick = () => { p.image = ''; markDirty(); renderPanel(); };
  box.querySelectorAll('[data-imgpos]').forEach((b) => b.onclick = () => { p.imagePos = b.dataset.imgpos; markDirty(); renderPanel(); });
  // form or link
  box.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => {
    if ((p.action || 'form') === b.dataset.action) return;
    p.action = b.dataset.action;
    ensureLink(p);
    // A form's default button text reads wrong on a plain link, and vice versa.
    if (p.action === 'link' && p.button === (S.blank && S.blank.button)) p.button = 'Find out more';
    markDirty(); renderPanel();
  });
  const nt = box.querySelector('#link-newtab');
  if (nt) nt.onchange = () => { ensureLink(p).newTab = nt.checked; markDirty(); };
  const lu = box.querySelector('#f-link_url');
  if (lu) lu.addEventListener('change', () => renderPanel());
  // form fields
  box.querySelectorAll('[data-fon]').forEach((c) => c.onchange = () => { field(c.dataset.fon).on = c.checked; markDirty(); renderPanel(); });
  box.querySelectorAll('[data-freq]').forEach((c) => c.onchange = () => { field(c.dataset.freq).required = c.checked; markDirty(); });
  box.querySelectorAll('[data-flabel]').forEach((c) => c.addEventListener('input', () => { field(c.dataset.flabel).label = c.value; markDirty(); }));
  box.querySelectorAll('[data-fprop]').forEach((c) => c.addEventListener('change', () => { field(c.dataset.fprop).property = c.value.trim(); markDirty(); renderPanel(); }));
  box.querySelectorAll('[data-fopts]').forEach((c) => c.addEventListener('input', () => {
    field(c.dataset.fopts).options = c.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [a, b] = l.split('|').map((s) => s.trim());
      return { label: a, value: b || a };
    });
    markDirty();
  }));
  box.querySelectorAll('[data-fload]').forEach((b) => b.onclick = () => {
    const f = field(b.dataset.fload);
    const pr = (S.props || []).find((x) => x.name === f.property);
    if (!pr) { toast(S.props ? `“${f.property}” isn't a HubSpot property` : 'HubSpot properties are still loading'); return; }
    if (!pr.options.length) { toast(`“${pr.label}” is a text property, so it has no fixed choices. Type your own.`); return; }
    f.options = pr.options.map((o) => ({ label: o.label, value: o.value }));
    markDirty();
    renderPanel();
    toast(`Loaded ${pr.options.length} choices from HubSpot`);
  });
  box.querySelectorAll('[data-fmv]').forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.fmv), j = i + Number(b.dataset.dir);
    const [f] = p.fields.splice(i, 1);
    p.fields.splice(j, 0, f);
    markDirty();
    renderPanel();
  });
  // team emails
  const ne = box.querySelector('#notify-emails');
  if (ne) {
    ne.addEventListener('input', () => { p.notify.emails = ne.value.split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 10); markDirty(); });
    ne.addEventListener('change', () => renderPanel());
  }
  const gc = box.querySelector('#gm-connect');
  if (gc) gc.onclick = async () => {
    if (S.dirty && !(await save(true))) return;
    try { sessionStorage.setItem('pdpop-return', S.cur); } catch { /* ignore */ }
    location.href = '/api/popups-gmail?action=connect';
  };
  const go = box.querySelector('#gm-off');
  if (go) go.onclick = async () => {
    if (!confirm('Disconnect this mailbox? Popup notification emails stop until another one is connected.')) return;
    await fetch('/api/popups-gmail', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"action":"disconnect"}' });
    await loadGmail();
  };
  const gt = box.querySelector('#gm-test');
  if (gt) gt.onclick = async () => {
    gt.disabled = true;
    gt.textContent = 'Sending…';
    try {
      const res = await fetch('/api/popups-gmail', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', to: p.notify.emails, name: p.name }) });
      const j = await res.json().catch(() => ({}));
      toast(res.ok ? `Test email sent to ${j.to.join(', ')}` : `Test failed: ${j.error || res.status}`, 6000);
    } finally { gt.disabled = false; gt.textContent = 'Send a test email'; }
  };
  // where & when
  box.querySelectorAll('[name=pmode]').forEach((r) => r.onchange = () => { p.pages.mode = r.value; markDirty(); renderPanel(); });
  const rules = box.querySelector('#prules');
  if (rules) rules.addEventListener('input', () => { p.pages.rules = rules.value.split('\n').map((s) => s.trim()).filter(Boolean); markDirty(); });
  const addRule = (r) => { if (!p.pages.rules.includes(r)) p.pages.rules.push(r); markDirty(); renderPanel(); };
  box.querySelectorAll('[data-addrule]').forEach((b) => b.onclick = () => addRule(b.dataset.addrule));
  const ap = box.querySelector('#addprog');
  if (ap) ap.onchange = () => ap.value && addRule(ap.value);
  box.querySelectorAll('[name=dev]').forEach((r) => r.onchange = () => { p.devices = r.value; markDirty(); });
  const num = (id, set) => { const el = box.querySelector(id); if (el) el.addEventListener('input', () => { set(Math.max(0, Number(el.value) || 0)); markDirty(); }); };
  num('#t-delay', (v) => { p.trigger.delay = v; });
  num('#t-scroll', (v) => { p.trigger.scroll = Math.min(100, v); });
  num('#hide-days', (v) => { p.frequency.hideDays = v; });
  const ex = box.querySelector('#t-exit');
  if (ex) ex.onchange = () => { p.trigger.exit = ex.checked; markDirty(); };
  const ds = box.querySelector('#d-start'); if (ds) ds.onchange = () => { p.starts = ds.value; markDirty(); syncToggle(); };
  const de = box.querySelector('#d-end'); if (de) de.onchange = () => { p.ends = de.value; markDirty(); syncToggle(); };
  // style
  box.querySelectorAll('[data-layout]').forEach((b) => b.onclick = () => { p.layout = b.dataset.layout; markDirty(); renderPanel(); });
  box.querySelectorAll('[data-accent]').forEach((b) => b.onclick = () => { p.accent = b.dataset.accent; markDirty(); renderPanel(); });
  const cc = box.querySelector('#accent-custom');
  if (cc) cc.addEventListener('input', () => { p.accent = cc.value; markDirty(); });
}

function field(key) { return cur().fields.find((f) => f.key === key); }

async function loadGmail() {
  try {
    const res = await fetch('/api/popups-gmail?action=status', { credentials: 'include' });
    S.gmail = res.ok ? await res.json() : { configured: true, connected: false, redirectUri: `${location.origin}/api/popups-gmail?action=callback` };
  } catch {
    S.gmail = { configured: true, connected: false, redirectUri: `${location.origin}/api/popups-gmail?action=callback` };
  }
  if (S.cur && S.tab === 'form') renderPanel();
}

async function loadProps() {
  try {
    S.props = (await api('GET', { action: 'properties' })).properties;
    S.propsErr = '';
  } catch (e) {
    S.props = null;
    S.propsErr = `Couldn't reach HubSpot (${e.message}). Type the property's internal name instead.`;
  }
  // First time: fill empty program/term dropdowns from HubSpot so the values always match.
  if (S.props) {
    let filled = false;
    for (const p of S.doc.popups) {
      for (const f of p.fields) {
        const pr = f.options && !f.options.length && f.property && S.props.find((x) => x.name === f.property);
        if (pr && pr.options.length) { f.options = pr.options.map((o) => ({ label: o.label, value: o.value })); filled = true; }
      }
    }
    if (filled && S.cur) { markDirty(); }
  }
  if (S.cur && S.tab === 'form') renderPanel();
}

async function loadPrograms() {
  S.programs = [];
  try {
    const res = await fetch('/api/program-pages?action=list', { credentials: 'include' });
    if (res.ok) S.programs = ((await res.json()).programs || []).sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* the quick-add list is optional */ }
  if (S.cur && S.tab === 'where') renderPanel();
}

async function uploadImage(file) {
  try {
    const blob = await shrink(file);
    const r = await api('POST', { action: 'upload' }, null, { type: blob.type, body: blob });
    cur().image = r.url;
    markDirty();
    renderPanel();
    toast('Image added');
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 6000);
  }
}

/** Resize to max 1600px wide so popups stay quick to load. GIFs are left alone. */
async function shrink(file) {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bmp.width);
  if (scale === 1 && file.size < 900 * 1024) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
}

load();
