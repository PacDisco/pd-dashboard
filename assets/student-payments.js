// Shared by /student-payments/ (Pacific Discovery) and /ue-student-payments/
// (Unearthed Education). Each page sets window.SP_CONFIG = { api } before
// loading this; the API it calls only ever returns that brand's payments.
const CFG = window.SP_CONFIG || {};
const API = CFG.api || '/api/student-payments';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'USD') => n == null ? '—' : `${cur === 'USD' ? '$' : cur + ' '}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const when = (d) => d ? new Date(d).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const dealUrl = (id) => `https://app.hubspot.com/contacts/3855728/record/0-3/${id}`;
const LABEL = { review: 'Needs a deal', error: 'Error', pending: 'Waiting', logged: 'Logged', already_logged: 'Already on deal', ignored: 'Ignored', watch: 'Would log' };
const TABS = [['attention', 'Needs attention'], ['logged', 'Logged'], ['already_logged', 'Already on deal'], ['watch', 'Watch mode'], ['pending', 'Waiting'], ['ignored', 'Ignored'], ['all', 'All']];
const S = { tab: 'attention', q: '', summary: null, rows: [], open: null };

async function api(method, params = {}, body) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  if (res.status === 401) notice('bad', 'Your sign-in has expired. <a href="/">Sign in again</a>.');
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
function notice(kind, html) { $('#notices').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : ''; }
function toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 4000); }

async function loadSummary() {
  const s = S.summary = await api('GET', { action: 'summary' });
  const c = s.counts;
  const r = s.state?.last_result || {};
  const b = s.brand || {};
  $('#syncState').textContent = s.state?.running ? 'Syncing…' : s.state?.last_run_at ? `Last sync ${when(s.state.last_run_at)}` : 'Not synced yet';
  const errs = [...(r.ingestErrors || []), r.error, r.pdfsError].filter(Boolean).map(esc);
  if (b.key === 'ue' && !b.configured) errs.push('Not connected yet — set <code>STRIPE_SECRET_KEY_UNEARTHED</code> (or <code>UE_STUDENT_PAYMENTS_STRIPE_KEYS</code>) and <code>UE_WISE_API_TOKEN</code> on the dashboard site. See STUDENT-PAYMENTS.md › Unearthed Education.');
  else if (b.mode === 'watch') errs.push(`<strong>Watch mode</strong>: payments are matched but nothing is written to HubSpot. ${c.watch || 0} in the Watch mode tab — check them against what’s been logged by hand, then set <code>UE_STUDENT_PAYMENTS_MODE=live</code>.`);
  notice(errs.length ? 'warn' : '', errs.join('<br>'));
  const sp = $('#stagePanel'); if (sp) sp.classList.toggle('hidden', !(b.configured && b.stages));
  $('#stats').innerHTML = [
    [c.review + c.error, 'Need a deal / errored'],
    [c.logged, 'Logged to deals'],
    [c.already_logged, 'Were already on the deal'],
    [c.pending, 'Waiting to process'],
    ...(c.watch || b.mode === 'watch' ? [[c.watch, 'Watch mode (not written)']] : []),
    ...(s.pdfs ? [[s.pdfs.attached, 'Application PDFs attached'], [s.pdfs.waiting, 'PDFs still to attach']] : []),
  ].map(([n, l]) => `<div class="stat"><div class="n">${n ?? 0}</div><div class="l">${l}</div></div>`).join('');
  const counts = { attention: c.review + c.error, all: Object.values(c).reduce((a, n) => a + n, 0), ...c };
  $('#tabs').innerHTML = TABS.filter(([k]) => k !== 'watch' || c.watch || b.mode === 'watch').map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${l}<span class="k">${counts[k] ?? 0}</span></button>`).join('');
  if (!s.pdfs || !$('#pdfLine')) return;
  $('#pdfLine').textContent = `${s.pdfs.attached} attached · ${s.pdfs.waiting} waiting · ${s.pdfs.no_hubspot} with no HubSpot record yet`;
  $('#pdfErrs').innerHTML = s.pdfs.recentErrors.length
    ? s.pdfs.recentErrors.map((a) => `<li><strong>${esc([a.first_name, a.last_name].join(' ') || a.email)}</strong> — <span class="muted">${esc(a.pdf_error)}</span> <button class="btn btn--sm" data-pdf-retry="${a.id}">Retry</button></li>`).join('')
    : '<li class="muted">No errors. PDFs attach a few at a time each sync, oldest application first.</li>';
}

async function loadList() {
  const { payments } = await api('GET', { action: 'list', status: S.tab, q: S.q });
  S.rows = payments; render();
}

function render() {
  if (!S.rows.length) { $('#list').innerHTML = `<div class="empty">${S.tab === 'attention' ? 'Nothing waiting — every payment has a deal.' : 'No payments here.'}</div>`; return; }
  $('#list').innerHTML = S.rows.map(row).join('');
}

function row(p) {
  const converted = p.currency !== 'USD';
  const queue = ['review', 'error'].includes(p.status);
  const deal = p.deal_id ? `<a href="${dealUrl(p.deal_id)}" target="_blank" rel="noopener">${esc(p.deal_name || p.deal_id)}</a>${p.slot ? ` <span class="muted">· payment_${p.slot}</span>` : ''}` : '';
  const cands = (p.candidates || []).map((d) => `<button class="btn btn--sm" data-assign="${p.id}" data-deal="${d.id}" title="${esc(d.name)}">Log to ${esc(d.name.split(/\s[-–—]\s/)[0])} <span class="muted">${money(d.paid)} / ${money(d.amount)}</span></button>`).join('');
  return `<div class="row" data-id="${p.id}">
    <div><div class="src">${esc(p.source)}</div><div class="muted">${when(p.received_at)}</div></div>
    <div><div><strong>${esc(p.payer_name || p.payer_email || 'Unknown payer')}</strong>${p.payer_name && p.payer_email ? ` <span class="muted">${esc(p.payer_email)}</span>` : ''}</div>
      <div class="ref">${esc(p.reference || '')}</div><div class="ref">${esc(p.external_id)}</div></div>
    <div><div class="amt">${money(p.amount_usd)}</div>${converted ? `<div class="muted">${money(p.amount, p.currency)}${p.fx_rate ? ` @ ${Number(p.fx_rate).toFixed(4)}` : ''}</div>` : ''}${p.fee_note ? `<div class="muted">${esc(p.fee_note)}</div>` : ''}</div>
    <div class="actions">
      <div><span class="chip c-${p.status}">${LABEL[p.status] || p.status}</span> ${deal}</div>
      ${p.reason ? `<div class="muted">${esc(p.reason)}</div>` : ''}
      ${p.stage_move ? `<div class="stage">Stage: ${esc(p.stage_move)}</div>` : ''}
      ${p.match_method && !queue ? `<div class="muted">Matched by ${esc(p.match_method.replace('_', ' '))}${p.resolved_by ? ` · ${esc(p.resolved_by)}` : ''}</div>` : ''}
      ${queue ? `${cands ? `<div class="cands">${cands}</div>` : ''}
        <div class="picker"><input class="inp" placeholder="Find the student's deal…" data-find="${p.id}" aria-label="Find deal"><div class="results" id="res-${p.id}"></div></div>
        <div><button class="btn btn--sm btn--ghost" data-ignore="${p.id}">Not a student payment</button><button class="btn btn--sm btn--ghost" data-requeue="${p.id}">Try matching again</button></div>` : ''}
      ${p.status === 'ignored' ? `<div><button class="btn btn--sm btn--ghost" data-requeue="${p.id}">Put back in queue</button></div>` : ''}
    </div></div>`;
}

let findTimer;
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { clearTimeout(findTimer); findTimer = setTimeout(() => { S.q = e.target.value.trim(); loadList().catch((x) => toast(x.message)); }, 300); return; }
  const id = e.target.dataset.find; if (!id) return;
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const box = $(`#res-${id}`); const term = e.target.value.trim();
    if (term.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="muted">Searching…</span>';
    try {
      const { deals } = await api('GET', { action: 'deals', q: term });
      box.innerHTML = deals.length ? deals.map((d) => `<div class="result"><span>${esc(d.name)} <span class="muted">${money(d.paid)} of ${money(d.amount)}</span></span><button class="btn btn--sm btn--primary" data-assign="${id}" data-deal="${d.id}">Log here</button></div>`).join('') : '<span class="muted">No deals found.</span>';
    } catch (x) { box.innerHTML = `<span class="muted">${esc(x.message)}</span>`; }
  }, 350);
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  try {
    if (t.dataset.tab) { S.tab = t.dataset.tab; await Promise.all([loadSummary(), loadList()]); return; }
    if (t.dataset.assign) {
      t.disabled = true;
      const { payment } = await api('POST', {}, { action: 'assign', id: Number(t.dataset.assign), dealId: t.dataset.deal });
      toast(payment.status === 'logged' ? `Logged to ${payment.deal_name} (payment_${payment.slot})` : payment.status === 'already_logged' ? `Already on ${payment.deal_name} — nothing written` : payment.reason || 'Still needs attention');
      await Promise.all([loadSummary(), loadList()]); return;
    }
    if (t.dataset.ignore) {
      const reason = prompt('Why? (optional — e.g. "Unearthed school payment")') ?? null;
      if (reason === null) return;
      await api('POST', {}, { action: 'ignore', id: Number(t.dataset.ignore), reason });
      await Promise.all([loadSummary(), loadList()]); return;
    }
    if (t.dataset.requeue) {
      await api('POST', {}, { action: 'requeue', id: Number(t.dataset.requeue) });
      toast('Back in the queue — it will be retried on the next sync.');
      await Promise.all([loadSummary(), loadList()]); return;
    }
    if (t.dataset.pdfRetry) { await api('POST', {}, { action: 'pdf-retry', id: t.dataset.pdfRetry }); toast('Will retry on the next sync.'); return; }
  } catch (x) { toast(x.message); t.disabled = false; }
});

$('#syncBtn').addEventListener('click', async () => {
  const b = $('#syncBtn'); b.disabled = true; b.textContent = 'Syncing…';
  try {
    const { result } = await api('POST', {}, { action: 'sync' });
    if (result.skipped) toast('A sync is already running — try again in a minute.');
    else toast(`Found ${(result.ingest?.stripe.added || 0) + (result.ingest?.wise.added || 0)} new · logged ${result.process?.logged || 0}${result.process?.watch ? ` · ${result.process.watch} previewed (watch mode)` : ''} · ${result.process?.review || 0} to review · ${result.pdfs?.attached || 0} PDFs attached`);
    await Promise.all([loadSummary(), loadList()]);
  } catch (x) { toast(x.message); }
  b.disabled = false; b.textContent = 'Sync now';
});

// ── deal stage check (Unearthed) ───────────────────────────────────────────
async function stageCheck(apply) {
  const btn = apply ? $('#stageApplyBtn') : $('#stageCheckBtn');
  btn.disabled = true; const label = btn.textContent; btn.textContent = apply ? 'Moving…' : 'Checking…';
  try {
    const { result } = await api('POST', {}, { action: 'stage-check', apply });
    const moves = result.moves || [];
    $('#stageList').innerHTML = moves.length
      ? moves.map((m) => `<li><a href="${dealUrl(m.dealId)}" target="_blank" rel="noopener">${esc(m.name)}</a> — ${esc(m.move)} <span class="muted">${esc(m.why)}</span>${m.applied ? ' <span class="chip c-logged">Moved</span>' : ''}${m.error ? ` <span class="chip c-error">${esc(m.error)}</span>` : ''}</li>`).join('')
        + (result.stoppedEarly ? '<li class="muted">Stopped early to stay within the time limit — press again to check the rest.</li>' : '')
      : `<li class="muted">Checked ${result.checked} open deals — every stage matches what's been paid.</li>`;
    $('#stageApplyBtn').classList.toggle('hidden', apply || !moves.length);
    if (apply) toast(`${moves.filter((m) => m.applied).length} deals moved`);
  } catch (x) { toast(x.message); }
  btn.disabled = false; btn.textContent = label;
}
if ($('#stageCheckBtn')) {
  $('#stageCheckBtn').addEventListener('click', () => stageCheck(false));
  $('#stageApplyBtn').addEventListener('click', () => { if (confirm('Move these deals to the stages listed?')) stageCheck(true); });
}

Promise.all([loadSummary(), loadList()]).catch((x) => notice('bad', esc(x.message)));

