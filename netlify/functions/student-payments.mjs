// netlify/functions/student-payments.mjs
//
// API behind /student-payments/ — the ledger of Stripe + Wise payments logged
// against HubSpot student deals, the review queue for the ones that couldn't
// be matched, and the application-PDF status.
//
// Every route needs a verified Identity session with access to the Student
// Payments dashboard.
//
// Routes (GET ?action=…, POST JSON { action, … }):
//   GET  summary                      → { state, counts, pdfs }
//   GET  list   ?status=&q=&limit=    → { payments }
//   GET  deals  ?q=                   → { deals }          (pick-a-deal search)
//   POST sync    { days? }            run a pass now (days > 3 is admin only, max 60)
//   POST assign  { id, dealId }       log a queued payment against a deal
//   POST ignore  { id, reason }       not a student payment (or handled by hand)
//   POST requeue { id }               back to pending; the matcher tries again
//   POST pdf-retry { id }             retry an application PDF that errored
//
// Env: see STUDENT-PAYMENTS.md

import { requireDashboard, json } from "./_shared/apply-form-access.mjs";
import { db, runSync, writeToDeal } from "./_shared/student-payments-run.mjs";
import { searchDeals } from "./_shared/hubspot-student.mjs";
import { candidateSummary } from "./_shared/deal-payments.mjs";

export const DASHBOARD_SLUG = "student-payments";
// Keep in step with student-payments/dashboard.json → allowedRoles.
export const ALLOWED_ROLES = ["admin", "operations", "admissions"];

const q = (text, params = []) => db().query(text, params);
const STATUSES = ["pending", "logged", "already_logged", "review", "ignored", "error"];

export default async function handler(req, context, deps = {}) {
  const user = await requireDashboard(req, DASHBOARD_SLUG, ALLOWED_ROLES, deps);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const action = url.searchParams.get("action") || "summary";
      if (action === "summary") return json(await summary());
      if (action === "list") return json(await list(url));
      if (action === "deals") return json({ deals: (await searchDeals(url.searchParams.get("q"))).map(candidateSummary) });
      return json({ error: "Unknown action" }, 400);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "sync": {
        const days = Math.max(1, Math.min(60, parseInt(body.days, 10) || 3));
        if (days > 3 && !user.isAdmin) return json({ error: "Only admins can look back more than 3 days." }, 403);
        return json({ result: await runSync({ trigger: `manual:${user.actor}`, budgetMs: 20_000, lookbackDays: days, pdfLimit: 8 }) });
      }
      case "assign": return await assign(body, user);
      case "ignore": return await setSimple(body.id, "ignored", `Ignored by ${user.actor}${body.reason ? `: ${String(body.reason).slice(0, 300)}` : ""}`, user);
      case "requeue": return await requeue(body.id);
      case "pdf-retry": {
        await q(`UPDATE applications SET pdf_error_at = NULL WHERE id = $1`, [String(body.id || "")]);
        return json({ ok: true });
      }
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e.code === "42P01" || e.code === "42703" || /does not exist/.test(e.message)) {
      return json({ error: "The database isn't set up for this yet — run MIGRATION-student-payments.sql in Neon." }, 500);
    }
    console.error("[student-payments]", e);
    return json({ error: e.message }, e.status && e.status < 500 ? e.status : 500);
  }
}

async function summary() {
  const [state] = await q(`SELECT last_run_at, last_result, (lock_until > now()) AS running FROM student_payment_state WHERE id = 1`);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of await q(`SELECT status, count(*)::int AS n FROM deal_payments GROUP BY status`)) counts[r.status] = r.n;
  const [pdfs] = await q(`SELECT
      count(*) FILTER (WHERE pdf_note_id IS NOT NULL)::int AS attached,
      count(*) FILTER (WHERE pdf_note_id IS NULL AND step2_at IS NOT NULL AND status <> 'withdrawn' AND (hubspot_contact_id IS NOT NULL OR hubspot_deal_id IS NOT NULL))::int AS waiting,
      count(*) FILTER (WHERE pdf_note_id IS NULL AND step2_at IS NOT NULL AND hubspot_contact_id IS NULL AND hubspot_deal_id IS NULL AND status <> 'withdrawn')::int AS no_hubspot,
      count(*) FILTER (WHERE pdf_error IS NOT NULL AND pdf_note_id IS NULL)::int AS errors
    FROM applications`);
  const pdfErrors = await q(`SELECT id, first_name, last_name, email, pdf_error, pdf_error_at FROM applications
    WHERE pdf_error IS NOT NULL AND pdf_note_id IS NULL ORDER BY pdf_error_at DESC LIMIT 20`);
  return { state: state || null, counts, pdfs: { ...pdfs, recentErrors: pdfErrors } };
}

async function list(url) {
  const status = url.searchParams.get("status") || "review";
  const text = (url.searchParams.get("q") || "").trim();
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit"), 10) || 200));
  const where = [];
  const params = [];
  if (status === "attention") where.push(`status IN ('review','error')`);
  else if (STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  if (text) {
    params.push(`%${text.toLowerCase()}%`);
    where.push(`(lower(coalesce(payer_name,'')) LIKE $${params.length} OR lower(coalesce(payer_email,'')) LIKE $${params.length}
      OR lower(coalesce(reference,'')) LIKE $${params.length} OR lower(coalesce(deal_name,'')) LIKE $${params.length}
      OR lower(external_id) LIKE $${params.length})`);
  }
  params.push(limit);
  const rows = await q(`SELECT id, source, external_id, account, received_at, amount, currency, amount_usd, fx_rate, fee_note,
      payer_name, payer_email, reference, status, reason, candidates, match_method, deal_id, deal_name, slot, resolved_by, updated_at
    FROM deal_payments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT $${params.length}`, params);
  return { payments: rows };
}

async function assign({ id, dealId }, user) {
  if (!/^\d{1,20}$/.test(String(dealId || ""))) return json({ error: "Pick a deal." }, 400);
  const [row] = await q(`SELECT * FROM deal_payments WHERE id = $1`, [id]);
  if (!row) return json({ error: "Not found" }, 404);
  if (["logged", "already_logged"].includes(row.status)) return json({ error: `Already logged against ${row.deal_name || row.deal_id}.` }, 409);
  const done = await writeToDeal(row, String(dealId), "manual", user.actor);
  return json({ payment: done });
}

async function setSimple(id, status, reason, user) {
  const rows = await q(`UPDATE deal_payments SET status = $2, reason = $3, resolved_by = $4, updated_at = now()
     WHERE id = $1 AND status NOT IN ('logged','already_logged') RETURNING *`, [id, status, reason, user.actor]);
  if (!rows[0]) return json({ error: "Not found, or already logged." }, 404);
  return json({ payment: rows[0] });
}

async function requeue(id) {
  const rows = await q(`UPDATE deal_payments SET status = 'pending', attempts = 0, reason = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('review','ignored','error') RETURNING *`, [id]);
  if (!rows[0]) return json({ error: "Not found, or not in the queue." }, 404);
  return json({ payment: rows[0] });
}
