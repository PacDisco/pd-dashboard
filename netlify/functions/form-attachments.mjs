// netlify/functions/form-attachments.mjs
//
// /api/form-attachments — status of the PDF attachments on HubSpot contacts,
// and "run now". Same access as the Student Payments dashboard.
//
//   GET                         → { state, kinds: { quiz|referral|step1|meta|application: { attached, waiting, errors, recentErrors } } }
//   POST { action: "run" }      run a pass now (also pulls new Meta leads)
//   POST { action: "retry", kind, id }   clear the backoff on one submission

import { requireDashboard, json } from "./_shared/apply-form-access.mjs";
import { db, runFormAttachments, ensureSchema, KINDS } from "./_shared/form-attachments-run.mjs";

const SLUG = "student-payments";
const ROLES = ["admin", "operations", "admissions"];
const q = (text, params = []) => db().query(text, params);

const LABEL_COLS = {
  quiz: "email AS who, created_at AS at",
  referral: "referred_email AS who, created_at AS at",
  step1: "email AS who, step1_at AS at",
  meta: "coalesce(email, id) AS who, created_time AS at",
};

export default async function handler(req, context, deps = {}) {
  const user = await requireDashboard(req, SLUG, ROLES, deps);
  if (user instanceof Response) return user;
  try {
    if (req.method === "GET") return json(await status());
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.action === "run") return json({ result: await runFormAttachments({ trigger: `manual:${user.actor}`, budgetMs: 20_000 }) });
    if (body.action === "retry") {
      const k = KINDS[body.kind];
      if (!k) return json({ error: "Unknown kind" }, 400);
      await q(`UPDATE ${k.table} SET ${k.prefix}_error_at = NULL, ${k.prefix}_attempts = 0 WHERE id::text = $1`, [String(body.id || "")]);
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[form-attachments]", e);
    return json({ error: e.message }, 500);
  }
}

async function status() {
  await ensureSchema();
  const [state] = await q(`SELECT last_run_at, last_result, (lock_until > now()) AS running FROM form_attachment_state WHERE id = 1`).catch(() => [null]);
  const kinds = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const p = k.prefix;
    const extra = kind === "step1" ? "AND step1_at IS NOT NULL AND step2_at IS NULL AND status <> 'withdrawn'" : "";
    try {
      const [c] = await q(`SELECT
          count(*) FILTER (WHERE ${p}_note_id IS NOT NULL)::int AS attached,
          count(*) FILTER (WHERE ${p}_note_id IS NULL ${extra})::int AS waiting,
          count(*) FILTER (WHERE ${p}_note_id IS NULL AND ${p}_error IS NOT NULL ${extra})::int AS errors
        FROM ${k.table}`);
      const recentErrors = await q(`SELECT id, ${LABEL_COLS[kind]}, ${p}_error AS error, ${p}_error_at AS error_at, ${p}_attempts AS attempts
        FROM ${k.table} WHERE ${p}_note_id IS NULL AND ${p}_error IS NOT NULL ${extra} ORDER BY ${p}_error_at DESC LIMIT 20`);
      kinds[kind] = { ...c, recentErrors };
    } catch (e) { kinds[kind] = { error: e.message }; }
  }
  try {
    const [a] = await q(`SELECT count(*) FILTER (WHERE pdf_note_id IS NOT NULL)::int AS attached,
        count(*) FILTER (WHERE pdf_note_id IS NULL AND step2_at IS NOT NULL AND status <> 'withdrawn')::int AS waiting,
        count(*) FILTER (WHERE pdf_note_id IS NULL AND pdf_error IS NOT NULL)::int AS errors
      FROM applications`);
    kinds.application = { ...a, note: "Full applications are attached by the student-payments sync (every 10 min)." };
  } catch (e) { kinds.application = { error: e.message }; }
  return { state: state || null, kinds };
}
