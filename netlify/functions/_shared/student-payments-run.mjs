// netlify/functions/_shared/student-payments-run.mjs
//
// One sync pass, shared by the 10-minute scheduled function and the dashboard's
// "Sync now" button:
//
//   1. INGEST   recent Stripe charges and Wise incoming payments → deal_payments
//               (ON CONFLICT DO NOTHING, so re-reading the same window is free).
//   2. PROCESS  pending rows older than SETTLE_MINUTES → match a deal → write
//               the next payment_N slot + total_amount_paid, or park the row
//               in the review queue with the reason and the candidate deals.
//   3. PDFs     full applications from pd-apply without an attached PDF → build,
//               upload to HubSpot Files, attach as a note on the contact + deal.
//
// Why wait SETTLE_MINUTES before processing: pd-apply writes the app fee to
// payment_1 itself right after checkout. Waiting lets that land first, so the
// reference check sees it and we don't log the fee twice.
//
// Every step stops starting new work once the deadline passes; whatever is
// left is picked up on the next pass.

import { neon } from "@neondatabase/serverless";
import { fromStripeCharge, fromWiseTransaction, matchPayment, planWrite, candidateSummary } from "./deal-payments.mjs";
import { stripeAccounts, listStripeCharges, listWiseCredits, usdRate, toUsd } from "./payment-sources.mjs";
import * as hub from "./hubspot-student.mjs";
import { buildApplicationPdf, pdfFileName, applicantName } from "./application-pdf.mjs";

export const SETTLE_MINUTES = 15;
const MAX_ATTEMPTS = 8;
const DEFAULT_LOOKBACK_DAYS = 3;

let _sql;
export function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}
export function __setSql(fn) { _sql = fn; }

let _deps = null;
/** Tests swap HubSpot / sources / FX for fakes. */
export function __setDeps(d) { _deps = d; }
function deps() {
  return _deps || {
    hub,
    stripeAccounts, listStripeCharges, listWiseCredits, usdRate,
    buildPdf: buildApplicationPdf,
  };
}

const q = (text, params = []) => db().query(text, params);

// ── lock ────────────────────────────────────────────────────────────────────

export async function acquireLock(seconds = 120) {
  const rows = await q(
    `UPDATE student_payment_state SET lock_until = now() + make_interval(secs => $1)
      WHERE id = 1 AND (lock_until IS NULL OR lock_until < now()) RETURNING id`, [seconds]);
  return rows.length === 1;
}
async function releaseLock(result) {
  await q(`UPDATE student_payment_state SET lock_until = NULL, last_run_at = now(), last_result = $1 WHERE id = 1`, [JSON.stringify(result)]);
}

// ── ingest ──────────────────────────────────────────────────────────────────

export function lookbackStart(days = DEFAULT_LOOKBACK_DAYS, env = process.env) {
  let since = Date.now() - days * 86_400_000;
  const floor = Date.parse(env.STUDENT_PAYMENTS_START || "");
  if (Number.isFinite(floor) && floor > since) since = floor;
  return since;
}

async function insertPayment(p) {
  if (!p || !p.external_id) return false;
  let amountUsd = null;
  let rate = null;
  try {
    rate = await deps().usdRate(p.currency, p.received_at.slice(0, 10));
    amountUsd = toUsd(p.amount, rate);
  } catch { /* processed later, FX is retried there */ }
  const ignored = p.fully_refunded;
  const rows = await q(
    `INSERT INTO deal_payments (source, external_id, account, received_at, amount, currency, amount_usd, fx_rate, fee_note,
        payer_name, payer_email, reference, metadata, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
    [p.source, p.external_id, p.account, p.received_at, p.amount, p.currency, amountUsd, rate === 1 ? null : rate, p.fee_note,
      p.payer_name, p.payer_email, p.reference, JSON.stringify(p.metadata || {}),
      ignored ? "ignored" : "pending", ignored ? "Refunded in full before it was logged" : null]);
  return rows.length === 1;
}

export async function ingest({ since, deadline }) {
  const out = { stripe: { seen: 0, added: 0 }, wise: { seen: 0, added: 0 }, errors: [] };
  const surchargeRate = Number(process.env.STRIPE_CARD_FEE_RATE ?? 0.035);
  for (const acct of deps().stripeAccounts()) {
    if (Date.now() > deadline) break;
    try {
      const charges = await deps().listStripeCharges({ key: acct.key, sinceSec: Math.floor(since / 1000) });
      for (const c of charges) {
        const row = fromStripeCharge(c, { account: acct.label, surchargeRate });
        if (!row) continue;
        out.stripe.seen++;
        if (await insertPayment(row)) out.stripe.added++;
      }
    } catch (e) { out.errors.push(`Stripe (${acct.label}): ${e.message}`); }
  }
  if (Date.now() < deadline) {
    try {
      const addBackFees = process.env.WISE_ADD_BACK_FEES !== "false";
      for (const { balance, transactions } of await deps().listWiseCredits({ since })) {
        for (const t of transactions) {
          const row = fromWiseTransaction(t, { account: `wise-${balance.currency}`, addBackFees });
          if (!row) continue;
          out.wise.seen++;
          if (await insertPayment(row)) out.wise.added++;
        }
      }
    } catch (e) { out.errors.push(`Wise: ${e.message}`); }
  }
  return out;
}

// ── process ─────────────────────────────────────────────────────────────────

function matcherDeps() {
  const h = deps().hub;
  let open = null;
  return {
    dealById: (id) => h.getDeal(id),
    dealsForEmail: (e) => h.dealsForEmail(e),
    dealsForPerson: (n) => h.dealsForPerson(n),
    openDeals: async () => (open ||= await h.openStudentDeals()),
  };
}

async function ensureUsd(row) {
  if (row.amount_usd != null) return Number(row.amount_usd);
  const rate = await deps().usdRate(row.currency, new Date(row.received_at).toISOString().slice(0, 10));
  const usd = toUsd(Number(row.amount), rate);
  await q(`UPDATE deal_payments SET amount_usd = $2, fx_rate = $3, updated_at = now() WHERE id = $1`, [row.id, usd, rate === 1 ? null : rate]);
  row.amount_usd = usd;
  return usd;
}

/**
 * Write one ledger row to one deal. Re-reads the deal first, so two payments
 * for the same student in one pass land in consecutive slots.
 */
export async function writeToDeal(row, dealId, method, actor = null) {
  const h = deps().hub;
  const deal = await h.getDeal(dealId);
  if (!deal) return setStatus(row.id, "review", { reason: `Deal ${dealId} not found in HubSpot`, deal_id: null });
  if (deal.currency && deal.currency !== "USD") {
    return setStatus(row.id, "review", { reason: `Deal is in ${deal.currency}, not USD — log it by hand`, candidates: [candidateSummary(deal)] });
  }
  const amountUsd = await ensureUsd(row);
  const plan = planWrite(deal.props, {
    source: row.source,
    ref: row.external_id,
    altRefs: [row.metadata?.charge_id].filter(Boolean),
    amountUsd,
    amount: Number(row.amount),
    currency: row.currency,
    fxRate: row.fx_rate ? Number(row.fx_rate) : null,
    date: new Date(row.received_at).toISOString().slice(0, 10),
  });
  const base = { deal_id: deal.id, deal_name: deal.name, match_method: method, resolved_by: actor };
  if (plan.action === "already") {
    return setStatus(row.id, "already_logged", { ...base, slot: plan.slot, reason: plan.why === "reference" ? "Already on the deal (same reference)" : "Already on the deal (same amount within 3 days)" });
  }
  if (plan.action === "full") {
    return setStatus(row.id, "review", { reason: "All 15 payment slots on this deal are used", candidates: [candidateSummary(deal)] });
  }
  await h.updateDeal(deal.id, { [plan.prop]: plan.line, total_amount_paid: String(plan.total) });
  return setStatus(row.id, "logged", { ...base, slot: plan.slot, reason: null });
}

const STATUS_COLS = ["reason", "candidates", "match_method", "deal_id", "deal_name", "slot", "resolved_by"];
async function setStatus(id, status, fields = {}) {
  const sets = ["status = $2", "updated_at = now()"];
  const params = [id, status];
  for (const k of STATUS_COLS) {
    if (!(k in fields)) continue;
    params.push(k === "candidates" ? JSON.stringify(fields[k] ?? null) : fields[k]);
    sets.push(`${k} = $${params.length}`);
  }
  const rows = await q(`UPDATE deal_payments SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
  return rows[0];
}

export async function processPending({ deadline, limit = 25 }) {
  const out = { logged: 0, already: 0, review: 0, errors: 0 };
  const rows = await q(
    `SELECT * FROM deal_payments WHERE status = 'pending' AND attempts < $1
       AND received_at < now() - make_interval(mins => $2)
     ORDER BY received_at LIMIT $3`, [MAX_ATTEMPTS, SETTLE_MINUTES, limit]);
  const md = matcherDeps();
  for (const row of rows) {
    if (Date.now() > deadline) break;
    try {
      const m = await matchPayment(row, md);
      const done = m.review
        ? await setStatus(row.id, "review", { reason: m.review, candidates: m.candidates })
        : await writeToDeal(row, m.dealId, m.method);
      if (done.status === "logged") out.logged++;
      else if (done.status === "already_logged") out.already++;
      else out.review++;
    } catch (e) {
      out.errors++;
      await q(
        `UPDATE deal_payments SET attempts = attempts + 1, reason = $2, updated_at = now(),
            status = CASE WHEN attempts + 1 >= $3 THEN 'error' ELSE status END WHERE id = $1`,
        [row.id, String(e.message).slice(0, 500), MAX_ATTEMPTS]);
    }
  }
  return out;
}

// ── application PDFs ────────────────────────────────────────────────────────

const _schemas = new Map();
async function schemaFor(rev) {
  const k = rev ?? "published";
  if (_schemas.has(k)) return _schemas.get(k);
  let schema = null;
  if (rev != null) {
    const [v] = await q(`SELECT data FROM apply_form_versions WHERE form_id = 'pd-application' AND rev = $1 ORDER BY created_at DESC LIMIT 1`, [rev]);
    schema = v?.data || null;
  }
  if (!schema) {
    const [f] = await q(`SELECT published, draft FROM apply_forms WHERE id = 'pd-application'`);
    schema = f?.published || f?.draft || null;
  }
  if (!schema) throw new Error("No pd-application form definition found");
  _schemas.set(k, schema);
  return schema;
}

export async function attachApplicationPdfs({ deadline, limit = 5 }) {
  const out = { attached: 0, relinked: 0, errors: 0, remaining: 0 };
  const h = deps().hub;
  const includePrivate = process.env.APPLICATION_PDF_INCLUDE_PRIVATE === "true";

  // A PDF attached before the fee was paid may predate the deal; link it once
  // the application has one (or a different one).
  const relink = await q(
    `SELECT id, pdf_note_id, hubspot_deal_id FROM applications
      WHERE pdf_note_id IS NOT NULL AND hubspot_deal_id IS NOT NULL AND pdf_deal_id IS DISTINCT FROM hubspot_deal_id LIMIT 20`);
  for (const a of relink) {
    if (Date.now() > deadline) break;
    try {
      await h.linkNoteToDeal(a.pdf_note_id, a.hubspot_deal_id);
      await q(`UPDATE applications SET pdf_deal_id = $2 WHERE id = $1`, [a.id, a.hubspot_deal_id]);
      out.relinked++;
    } catch (e) { out.errors++; console.warn("[student-payments] relink", a.id, e.message); }
  }

  const todoWhere = `step2_at IS NOT NULL AND status <> 'withdrawn' AND pdf_note_id IS NULL
      AND (hubspot_contact_id IS NOT NULL OR hubspot_deal_id IS NOT NULL)
      AND (pdf_error_at IS NULL OR pdf_error_at < now() - interval '1 hour')`;
  const apps = await q(`SELECT * FROM applications WHERE ${todoWhere} ORDER BY step2_at LIMIT $1`, [limit]);
  for (const app of apps) {
    if (Date.now() > deadline) break;
    try {
      const schema = await schemaFor(app.form_rev);
      const bytes = deps().buildPdf({ app, schema, includePrivate });
      const fileId = await h.uploadFile(bytes, pdfFileName(app));
      const when = new Date(app.step2_at).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" });
      const noteId = await h.createNote({
        body: `<p><strong>Application — ${escapeHtml(applicantName(app))}</strong><br>${escapeHtml(app.program || "")}${app.term ? ` · ${escapeHtml(app.term)}` : ""}<br>Submitted on apply.pacificdiscovery.org, ${when}. PDF attached.</p>`,
        fileId, contactId: app.hubspot_contact_id, dealId: app.hubspot_deal_id, timestamp: new Date(app.step2_at).toISOString(),
      });
      await q(
        `UPDATE applications SET pdf_note_id = $2, pdf_file_id = $3, pdf_deal_id = $4, pdf_attached_at = now(), pdf_error = NULL, pdf_error_at = NULL WHERE id = $1`,
        [app.id, noteId, fileId, app.hubspot_deal_id || null]);
      out.attached++;
    } catch (e) {
      out.errors++;
      await q(`UPDATE applications SET pdf_error = $2, pdf_error_at = now() WHERE id = $1`, [app.id, String(e.message).slice(0, 500)]);
    }
  }
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM applications WHERE ${todoWhere}`);
  out.remaining = n;
  return out;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── one pass ────────────────────────────────────────────────────────────────

/**
 * @param {{ budgetMs?: number, lookbackDays?: number, pdfLimit?: number, trigger?: string }} opts
 * @returns result summary, or { skipped: 'locked' } when another pass is running.
 */
export async function runSync({ budgetMs = 20_000, lookbackDays = DEFAULT_LOOKBACK_DAYS, pdfLimit = 5, trigger = "schedule" } = {}) {
  if (!(await acquireLock())) return { skipped: "locked" };
  const started = Date.now();
  const deadline = started + budgetMs;
  const result = { trigger, startedAt: new Date(started).toISOString() };
  try {
    result.ingest = await ingest({ since: lookbackStart(lookbackDays), deadline });
    result.process = await processPending({ deadline });
    try { result.pdfs = await attachApplicationPdfs({ deadline: deadline + 4000, limit: pdfLimit }); }
    catch (e) { result.pdfs = { error: e.message }; }
  } catch (e) {
    result.error = e.message;
  } finally {
    result.ms = Date.now() - started;
    await releaseLock(result).catch(() => {});
  }
  return result;
}
