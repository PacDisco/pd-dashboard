// netlify/functions/_shared/student-payments-api.mjs
//
// The API behind both payments dashboards. Each dashboard gets its own handler
// locked to ONE brand — a user of the Pacific Discovery dashboard can't see,
// assign, ignore or requeue an Unearthed payment, and the other way round.
//
//   /student-payments/     → /api/student-payments     brand pd  (student-payments.mjs)
//   /ue-student-payments/  → /api/ue-student-payments  brand ue  (ue-student-payments.mjs)
//
// Every route needs a verified Identity session with access to that dashboard.
//
// Routes (GET ?action=…, POST JSON { action, … }):
//   GET  summary                      → { state, counts, brand, pdfs? }
//   GET  list   ?status=&q=&limit=    → { payments }
//   GET  deals  ?q=                   → { deals }          (pick-a-deal search)
//   POST sync    { days? }            run a pass for this brand now (days > 3 admin only, max 60)
//   POST assign  { id, dealId }       log a queued payment against a deal
//   POST ignore  { id, reason }       not a student payment (or handled by hand)
//   POST requeue { id }               back to pending; the matcher tries again
//   POST stage-check { apply }        brands that move stages (UE): which open deals
//                                     are behind what's been paid; apply=true moves
//                                     them (admin only)
//   POST pdf-retry { id }             PD only: retry an application PDF that errored
//
// Env: see STUDENT-PAYMENTS.md

import { requireDashboard, json } from "./apply-form-access.mjs";
import { db, runSync, writeToDeal, brands, checkStages, hubApi } from "./student-payments-run.mjs";
import { brandConfigured } from "./payment-brands.mjs";
import { candidateSummary } from "./deal-payments.mjs";

const q = (text, params = []) => db().query(text, params);
export const STATUSES = ["pending", "logged", "already_logged", "review", "ignored", "error", "watch"];

/**
 * @param {{ slug: string, roles: string[], brand: 'pd'|'ue' }} cfg
 */
export function makeHandler({ slug, roles, brand }) {
  const hasPdfs = brand === "pd"; // application + lead-form PDFs are pd-apply's

  return async function handler(req, context, deps = {}) {
    const user = await requireDashboard(req, slug, roles, deps);
    if (user instanceof Response) return user;
    const url = new URL(req.url);
    const cfg = brands().find((b) => b.key === brand) || null;
    try {
      if (req.method === "GET") {
        const action = url.searchParams.get("action") || "summary";
        if (action === "summary") return json(await summary());
        if (action === "list") return json(await list(url));
        if (action === "deals") return json({ deals: await findDeals(url.searchParams.get("q")) });
        return json({ error: "Unknown action" }, 400);
      }
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const body = await req.json().catch(() => ({}));
      switch (body.action) {
        case "sync": {
          const days = Math.max(1, Math.min(60, parseInt(body.days, 10) || 3));
          if (days > 3 && !user.isAdmin) return json({ error: "Only admins can look back more than 3 days." }, 403);
          return json({ result: await runSync({ trigger: `manual:${user.actor}`, budgetMs: 20_000, lookbackDays: days, pdfLimit: hasPdfs ? 8 : 0, only: [brand] }) });
        }
        case "assign": return await assign(body, user);
        case "ignore": return await setSimple(body.id, "ignored", `Ignored by ${user.actor}${body.reason ? `: ${String(body.reason).slice(0, 300)}` : ""}`, user);
        case "requeue": return await requeue(body.id);
        case "stage-check": {
          if (!cfg?.stages) return json({ error: "This dashboard doesn't move deal stages." }, 400);
          const apply = body.apply === true;
          if (apply && !user.isAdmin) return json({ error: "Only admins can move deal stages in bulk." }, 403);
          return json({ result: await checkStages({ brand, apply, deadline: Date.now() + 20_000 }) });
        }
        case "pdf-retry": {
          if (!hasPdfs) return json({ error: "Unknown action" }, 400);
          await q(`UPDATE applications SET pdf_error_at = NULL WHERE id = $1`, [String(body.id || "")]);
          return json({ ok: true });
        }
        default: return json({ error: "Unknown action" }, 400);
      }
    } catch (e) {
      if (e.code === "42P01" || e.code === "42703" || /does not exist/.test(e.message)) {
        return json({ error: "The database isn't set up for this yet — run MIGRATION-student-payments.sql, then MIGRATION-student-payments-brands.sql, in Neon." }, 500);
      }
      console.error(`[${slug}]`, e);
      return json({ error: e.message }, e.status && e.status < 500 ? e.status : 500);
    }
  };

  async function summary() {
    const [state] = await q(`SELECT last_run_at, last_result, (lock_until > now()) AS running FROM student_payment_state WHERE id = 1`);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of await q(`SELECT status, count(*)::int AS n FROM deal_payments WHERE brand = $1 GROUP BY status`, [brand])) counts[r.status] = r.n;
    const cfg = brands().find((b) => b.key === brand);
    // The last run's result, cut down to this brand (errors from the other
    // brand's accounts aren't this dashboard's business).
    const last = state?.last_result || {};
    const mine = last.ingest?.byBrand?.[brand];
    const lastResult = {
      error: last.error || null,
      ingestErrors: mine?.errors || (brand === "pd" && !last.ingest?.byBrand ? last.ingest?.errors || [] : []),
      ...(hasPdfs ? { pdfsError: last.pdfs?.error || null } : {}),
    };
    const out = {
      state: state ? { last_run_at: state.last_run_at, running: state.running, last_result: lastResult } : null,
      counts,
      brand: cfg ? { key: cfg.key, label: cfg.label, mode: cfg.mode, configured: brandConfigured(cfg), stages: cfg.stages } : { key: brand, mode: "off", configured: false },
    };
    if (hasPdfs) {
      const [pdfs] = await q(`SELECT
          count(*) FILTER (WHERE pdf_note_id IS NOT NULL)::int AS attached,
          count(*) FILTER (WHERE pdf_note_id IS NULL AND step2_at IS NOT NULL AND status <> 'withdrawn' AND (hubspot_contact_id IS NOT NULL OR hubspot_deal_id IS NOT NULL))::int AS waiting,
          count(*) FILTER (WHERE pdf_note_id IS NULL AND step2_at IS NOT NULL AND hubspot_contact_id IS NULL AND hubspot_deal_id IS NULL AND status <> 'withdrawn')::int AS no_hubspot,
          count(*) FILTER (WHERE pdf_error IS NOT NULL AND pdf_note_id IS NULL)::int AS errors
        FROM applications`);
      const recentErrors = await q(`SELECT id, first_name, last_name, email, pdf_error, pdf_error_at FROM applications
        WHERE pdf_error IS NOT NULL AND pdf_note_id IS NULL ORDER BY pdf_error_at DESC LIMIT 20`);
      out.pdfs = { ...pdfs, recentErrors };
    }
    return out;
  }

  async function list(url) {
    const status = url.searchParams.get("status") || "review";
    const text = (url.searchParams.get("q") || "").trim();
    const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit"), 10) || 200));
    const params = [brand];
    const where = ["brand = $1"];
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
        payer_name, payer_email, reference, status, reason, candidates, match_method, deal_id, deal_name, slot, resolved_by, updated_at,
        stage_move
      FROM deal_payments WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT $${params.length}`, params);
    return { payments: rows };
  }

  /** Deal search for the picker. A brand with strict pipelines only offers its own deals. */
  async function findDeals(text) {
    const cfg = brands().find((b) => b.key === brand);
    let found = await hubApi().searchDeals(text);
    if (cfg?.strictPipelines) found = found.filter((d) => cfg.pipelines.includes(String(d.pipeline)));
    return found.map(candidateSummary);
  }

  async function assign({ id, dealId }, user) {
    if (!/^\d{1,20}$/.test(String(dealId || ""))) return json({ error: "Pick a deal." }, 400);
    const [row] = await q(`SELECT * FROM deal_payments WHERE id = $1 AND brand = $2`, [id, brand]);
    if (!row) return json({ error: "Not found" }, 404);
    if (["logged", "already_logged"].includes(row.status)) return json({ error: `Already logged against ${row.deal_name || row.deal_id}.` }, 409);
    const cfg = brands().find((b) => b.key === brand);
    if (cfg?.strictPipelines) {
      const d = await hubApi().getDeal(String(dealId));
      if (d && !cfg.pipelines.includes(String(d.pipeline))) {
        return json({ error: `That deal isn't in the ${cfg.label} student pipeline. Move it there in HubSpot first, then log the payment.` }, 400);
      }
    }
    const done = await writeToDeal(row, String(dealId), "manual", user.actor);
    return json({ payment: done });
  }

  async function setSimple(id, status, reason, user) {
    const rows = await q(`UPDATE deal_payments SET status = $2, reason = $3, resolved_by = $4, updated_at = now()
       WHERE id = $1 AND brand = $5 AND status NOT IN ('logged','already_logged') RETURNING *`, [id, status, reason, user.actor, brand]);
    if (!rows[0]) return json({ error: "Not found, or already logged." }, 404);
    return json({ payment: rows[0] });
  }

  async function requeue(id) {
    const rows = await q(`UPDATE deal_payments SET status = 'pending', attempts = 0, reason = NULL, updated_at = now()
       WHERE id = $1 AND brand = $2 AND status IN ('review','ignored','error') RETURNING *`, [id, brand]);
    if (!rows[0]) return json({ error: "Not found, or not in the queue." }, 404);
    return json({ payment: rows[0] });
  }
}
