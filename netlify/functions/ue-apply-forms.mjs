// netlify/functions/ue-apply-forms.mjs
//
// API behind /ue-apply-form/ — the Unearthed Application Form dashboard. Edits
// the form served by the ue-apply site (apply.unearthededucation.org), its trip
// launch links, and lists the applications it collects. Separate from Pacific
// Discovery's Apply Form (apply-forms.mjs): own tables, own access.
//
// Two forms: the student application (form=student, default) and the teacher
// application (form=teacher, apply.unearthededucation.org/<trip>/teacher).
// The form actions below take `form` (query on GET, body on POST).
//
// GET  ?action=get                      → { form, lint }
// GET  ?action=versions                 → { versions }
// GET  ?action=hubspot                  → { contactProps, dealProps }   (field → property mapping)
// GET  ?action=programs                 → { programs: [{ id, name }] }  (Unearthed Program records)
// GET  ?action=trips                    → { trips }
// GET  ?action=applications &q= &trip= &status= → { applications, counts }
// GET  ?action=application &id=         → { app, files }
// GET  ?action=file &id=                → the file (proxied from ue-apply)
// GET  ?action=waiver-pdf &id=          → the signed permissions packet PDF
// POST { action: "save", draft, rev }   { action: "publish", rev, note }   { action: "discard" }
// POST { action: "restore", versionId }
// POST { action: "import-jotform", formId }   → new draft from the live Jotform form
// POST { action: "trip-save", trip }    { action: "trip-delete", slug }
// POST { action: "resync", id, only? }  { action: "lookup", email }  { action: "import", email, slug, dealId? }
// POST { action: "send-waiver", id, email? }  { action: "withdraw", id }
// POST { action: "create-teacher-form", replace? } → teacher draft from the student form
// POST { action: "approve-teacher", id }   Teacher label on the trip (→ leader portal)
//
// Env: HUBSPOT_TOKEN, JOTFORM_API_KEY (already set), UE_APPLY_SITE_URL
// (https://apply.unearthededucation.org) and UE_APPLY_SERVICE_KEY (same secret
// as APPLY_SERVICE_KEY on the ue-apply site).

import { neon } from "@neondatabase/serverless";
import { requireDashboard, json } from "./_shared/apply-form-access.mjs";
import { lintSchema, teacherSchemaFrom } from "../../ue-apply-form/form-kit.mjs";
import { jotformToSchema } from "../../ue-apply-form/jotform-import.mjs";

export const DASHBOARD_SLUG = "ue-apply-form";
// Keep in step with ue-apply-form/dashboard.json → allowedRoles.
export const ALLOWED_ROLES = ["admin", "operations", "unearthed"];
export const FORM_ID = "ue-application";
export const FORM_IDS = { student: "ue-application", teacher: "ue-teacher-application" };
/** "teacher" → the teacher form's row id; anything else → the student form. */
export const formIdOf = (f) => (f === "teacher" ? FORM_IDS.teacher : FORM_IDS.student);
const PROGRAM_OBJECT = process.env.UE_PROGRAM_OBJECT_TYPE || "2-58156993";
export const MAX_SCHEMA_BYTES = 900 * 1024;

let _sql;
export function __setSql(fn) { _sql = fn; }
function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}
const q = (text, params = []) => db().query(text, params);

let _fetch = (...a) => fetch(...a);
/** Tests swap in fakes for HubSpot / Jotform / the ue-apply service. */
export function __setFetch(f) { _fetch = f; }

export default async function handler(req, context, deps = {}) {
  const user = await requireDashboard(req, DASHBOARD_SLUG, ALLOWED_ROLES, deps);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const a = url.searchParams.get("action") || "get";
      const fid = formIdOf(url.searchParams.get("form"));
      if (a === "get") return json(await getForm(fid));
      if (a === "versions") return json({ versions: await q(`SELECT id, kind, rev, note, created_at, created_by FROM ue_apply_form_versions WHERE form_id = $1 ORDER BY id DESC LIMIT 50`, [fid]) });
      if (a === "hubspot") return json(await hubspotProps());
      if (a === "programs") return json({ programs: await programs() });
      if (a === "trips") return json({ trips: await trips() });
      if (a === "applications") return json(await listApplications(url));
      if (a === "application") return json(await getApplication(url.searchParams.get("id")));
      if (a === "file") return await proxy(`/api/file/${encodeURIComponent(url.searchParams.get("id") || "")}`, { method: "GET" });
      if (a === "waiver-pdf") return await proxy(`/api/service`, { method: "POST", body: { action: "waiver-pdf", id: url.searchParams.get("id") } });
      if (a === "version") {
        const [v] = await q(`SELECT data FROM ue_apply_form_versions WHERE id = $1 AND form_id = $2`, [Number(url.searchParams.get("id")), fid]);
        return v ? json({ data: v.data }) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Unknown action" }, 400);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const b = await req.json().catch(() => ({}));
    const fid = formIdOf(b.form);
    switch (b.action) {
      case "save": return await save(b, user, fid);
      case "publish": return await publish(b, user, fid);
      case "discard": return await discard(user, fid);
      case "restore": return await restore(b, user, fid);
      case "import-jotform": return await importJotform(b, user);
      case "create-teacher-form": return await createTeacherForm(b, user);
      case "approve-teacher": return await proxy(`/api/service`, { method: "POST", body: { action: "approve-teacher", id: b.id, actor: user.actor, role: b.role } });
      case "trip-save": return await tripSave(b.trip, user);
      case "trip-delete": {
        const [{ n }] = await q(`SELECT count(*)::int AS n FROM ue_applications WHERE trip_slug = $1`, [String(b.slug || "")]);
        if (n) return json({ error: `${n} application(s) use this link — close it instead of deleting it.` }, 409);
        await q(`DELETE FROM ue_apply_trips WHERE slug = $1`, [String(b.slug || "")]);
        return json({ ok: true });
      }
      case "resync": return await proxy(`/api/service`, { method: "POST", body: { action: "resync", id: b.id, only: b.only } });
      case "lookup": return await proxy(`/api/service`, { method: "POST", body: { action: "lookup", email: b.email } });
      case "import": return await proxy(`/api/service`, { method: "POST", body: { action: "import", email: b.email, slug: b.slug, dealId: b.dealId, actor: user.actor } });
      case "send-waiver": return await proxy(`/api/service`, { method: "POST", body: { action: "send-waiver", id: b.id, email: b.email, actor: user.actor } });
      case "withdraw": return await proxy(`/api/service`, { method: "POST", body: { action: "withdraw", id: b.id, actor: user.actor } });
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e.code === "42P01" || /relation "ue_/.test(e.message || "")) return json({ error: "Run MIGRATION-ue-apply.sql in Neon first." }, 500);
    if (e.code === "42703" && /kind|approval/.test(e.message || "")) return json({ error: "Run MIGRATION-ue-apply-teachers.sql in Neon first." }, 500);
    console.error("[ue-apply-forms]", e);
    return json({ error: e.message }, e.status && e.status < 500 ? e.status : 500);
  }
}

// ── form: draft / publish / versions ───────────────────────────────────────

const shape = (r) => r && ({ draft: r.draft, draftRev: r.draft_rev, published: !!r.published, publishedRev: r.published_rev, publishedAt: r.published_at, publishedBy: r.published_by, updatedAt: r.updated_at, updatedBy: r.updated_by, changed: !!r.published && JSON.stringify(r.draft) !== JSON.stringify(r.published) });

async function loadRow(fid = FORM_ID) {
  const [r] = await q(`SELECT * FROM ue_apply_forms WHERE id = $1`, [fid]);
  return r || null;
}

async function getForm(fid = FORM_ID) {
  const r = await loadRow(fid);
  return { form: shape(r), lint: r?.draft ? lintSchema(r.draft) : [] };
}

export function checkDraft(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "The form must be an object.";
  if (!Array.isArray(d.steps) || !d.steps.find((s) => s.key === "step1") || !d.steps.find((s) => s.key === "step2")) return "The form needs its About you and Application pages.";
  if (JSON.stringify(d).length > MAX_SCHEMA_BYTES) return "The form is too large to save.";
  return null;
}

async function save(b, user, fid = FORM_ID) {
  const err = checkDraft(b.draft);
  if (err) return json({ error: err }, 400);
  if ((fid === FORM_IDS.teacher) !== (b.draft?.settings?.kind === "teacher")) return json({ error: "That draft belongs to the other form — reload the page." }, 409);
  const row = await loadRow(fid);
  if (row && Number(b.rev) !== row.draft_rev) return json({ error: "Someone else changed the form since you loaded it — reload to see their changes.", conflict: { rev: row.draft_rev } }, 409);
  const [r] = row
    ? await q(`UPDATE ue_apply_forms SET draft = $2, draft_rev = draft_rev + 1, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [fid, JSON.stringify(b.draft), user.actor])
    : await q(`INSERT INTO ue_apply_forms (id, draft, draft_rev, updated_by) VALUES ($1, $2, 1, $3) RETURNING *`, [fid, JSON.stringify(b.draft), user.actor]);
  return json({ form: shape(r), lint: lintSchema(r.draft) });
}

async function publish(b, user, fid = FORM_ID) {
  const row = await loadRow(fid);
  if (!row?.draft) return json({ error: "Nothing to publish." }, 404);
  if (Number(b.rev) !== row.draft_rev) return json({ error: "The form changed since you loaded it — reload and try again.", conflict: { rev: row.draft_rev } }, 409);
  const errs = lintSchema(row.draft).filter((x) => x.level === "error");
  if (errs.length) return json({ error: `Fix these first: ${errs.map((e) => e.message).join(" ")}`, lint: errs }, 422);
  await q(`UPDATE ue_apply_forms SET published = draft, published_rev = draft_rev, published_at = now(), published_by = $2 WHERE id = $1`, [fid, user.actor]);
  await q(`INSERT INTO ue_apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES ($1, 'publish', $2, $3, $4, $5)`, [fid, row.draft_rev, JSON.stringify(row.draft), String(b.note || "").slice(0, 300) || null, user.actor]);
  return json({ publishedRev: row.draft_rev, note: "Live within about 30 seconds." });
}

async function discard(user, fid = FORM_ID) {
  const [r] = await q(`UPDATE ue_apply_forms SET draft = published, draft_rev = draft_rev + 1, updated_at = now(), updated_by = $2 WHERE id = $1 AND published IS NOT NULL RETURNING *`, [fid, user.actor]);
  if (!r) return json({ error: "There is no published version to go back to." }, 409);
  return json({ form: shape(r), lint: lintSchema(r.draft) });
}

async function restore(b, user, fid = FORM_ID) {
  const [v] = await q(`SELECT data, rev FROM ue_apply_form_versions WHERE id = $1 AND form_id = $2`, [Number(b.versionId), fid]);
  if (!v) return json({ error: "Version not found." }, 404);
  const [r] = await q(`UPDATE ue_apply_forms SET draft = $2, draft_rev = draft_rev + 1, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [fid, JSON.stringify(v.data), user.actor]);
  await q(`INSERT INTO ue_apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES ($1, 'restore', $2, $3, $4, $5)`, [fid, r.draft_rev, JSON.stringify(v.data), `Restored rev ${v.rev}`, user.actor]);
  return json({ form: shape(r), lint: lintSchema(r.draft) });
}

/**
 * The teacher form, started from the student form: the same questions minus
 * parents / guardians, plus one emergency contact (form-kit teacherSchemaFrom).
 * Won't overwrite an existing teacher form unless `replace` is set.
 */
async function createTeacherForm(b, user) {
  const existing = await loadRow(FORM_IDS.teacher);
  if (existing?.draft && !b.replace) return json({ error: "There's already a teacher form. Tick “replace” to start it again from the student form." }, 409);
  const student = await loadRow(FORM_IDS.student);
  const base = student?.published || student?.draft;
  if (!base) return json({ error: "Set up the student form first — the teacher form starts as a copy of it." }, 409);
  const { schema, removed } = teacherSchemaFrom(base);
  const [r] = existing
    ? await q(`UPDATE ue_apply_forms SET draft = $2, draft_rev = draft_rev + 1, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [FORM_IDS.teacher, JSON.stringify(schema), user.actor])
    : await q(`INSERT INTO ue_apply_forms (id, draft, draft_rev, updated_by) VALUES ($1, $2, 1, $3) RETURNING *`, [FORM_IDS.teacher, JSON.stringify(schema), user.actor]);
  await q(`INSERT INTO ue_apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES ($1, 'import', $2, $3, $4, $5)`, [FORM_IDS.teacher, r.draft_rev, JSON.stringify(schema), "Started from the student form", user.actor]);
  return json({ form: shape(r), lint: lintSchema(r.draft), removed });
}

// ── import from the live Jotform form ──────────────────────────────────────

async function jotform(path) {
  const key = process.env.JOTFORM_API_KEY;
  if (!key) throw Object.assign(new Error("JOTFORM_API_KEY is not set on this site."), { status: 500 });
  const base = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
  const r = await _fetch(`${base}${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(key)}`, { headers: { Accept: "application/json" } });
  const data = await r.json().catch(() => null);
  if (!r.ok || (data?.responseCode && data.responseCode >= 400)) throw Object.assign(new Error(`Jotform ${path.split("?")[0]} → ${r.status}: ${data?.message || ""}`), { status: 502 });
  return data?.content;
}

async function importJotform(b, user) {
  const formId = String(b.formId || "251396787451873").replace(/\D/g, "");
  const [questions, properties] = await Promise.all([jotform(`/form/${formId}/questions`), jotform(`/form/${formId}/properties`)]);
  const { schema, report } = jotformToSchema(questions, properties, formId);
  const row = await loadRow();
  // Keep anything already written in the dashboard that the import doesn't produce.
  if (row?.draft) {
    schema.settings = { ...(row.draft.settings || {}), jotform: { formId } };
    if (row.draft.waiver) schema.waiver = row.draft.waiver;
  }
  const [r] = row
    ? await q(`UPDATE ue_apply_forms SET draft = $2, draft_rev = draft_rev + 1, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [FORM_ID, JSON.stringify(schema), user.actor])
    : await q(`INSERT INTO ue_apply_forms (id, draft, draft_rev, updated_by) VALUES ($1, $2, 1, $3) RETURNING *`, [FORM_ID, JSON.stringify(schema), user.actor]);
  await q(`INSERT INTO ue_apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES ($1, 'import', $2, $3, $4, $5)`, [FORM_ID, r.draft_rev, JSON.stringify(schema), `Imported from Jotform ${formId}`, user.actor]);
  return json({ form: shape(r), lint: lintSchema(r.draft), report });
}

// ── HubSpot ────────────────────────────────────────────────────────────────

async function hs(path) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw Object.assign(new Error("HUBSPOT_TOKEN is not set"), { status: 500 });
  const r = await _fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Object.assign(new Error(`HubSpot ${path.split("?")[0]} → ${r.status}`), { status: 502 });
  return r.json();
}

let _props = null;
async function hubspotProps() {
  if (_props && Date.now() - _props.at < 10 * 60 * 1000) return _props.data;
  const [c, d] = await Promise.allSettled([hs("/crm/v3/properties/contacts"), hs("/crm/v3/properties/deals")]);
  const writable = (r) => (r.status === "fulfilled" ? r.value.results || [] : [])
    .filter((p) => !p.modificationMetadata?.readOnlyValue && !p.calculated && !p.hidden)
    .map((p) => ({ name: p.name, label: p.label, type: p.type }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const data = { contactProps: writable(c), dealProps: writable(d) };
  _props = { at: Date.now(), data };
  return data;
}

async function programs() {
  const out = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const page = await hs(`/crm/v3/objects/${PROGRAM_OBJECT}?limit=100&properties=unearthed_program,payment_amount_1,program_currency,school_collecting_payments${after ? `&after=${after}` : ""}`);
    for (const o of page.results || []) {
      const p = o.properties || {};
      if (!p.unearthed_program || /global portal|sample portal/i.test(p.unearthed_program)) continue;
      out.push({ id: String(o.id), name: p.unearthed_program, deposit: p.payment_amount_1 || null, currency: p.program_currency || null, schoolCollecting: String(p.school_collecting_payments || "") === "true" });
    }
    after = page.paging?.next?.after;
    if (!after) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── trips (launch links) ───────────────────────────────────────────────────

async function trips() {
  return q(`SELECT t.*,
      (SELECT count(*)::int FROM ue_applications a WHERE a.trip_slug = t.slug AND a.status <> 'withdrawn' AND a.kind = 'student') AS applications,
      (SELECT count(*)::int FROM ue_applications a WHERE a.trip_slug = t.slug AND a.status <> 'withdrawn' AND a.kind = 'teacher') AS staff,
      (SELECT count(*)::int FROM ue_applications a WHERE a.trip_slug = t.slug AND a.status = 'paid') AS paid
    FROM ue_apply_trips t ORDER BY t.created_at DESC`);
}

export function cleanTrip(t) {
  const slug = String(t?.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) return { error: "The link name can only use lowercase letters, numbers and dashes (e.g. otago-boys-borneo-2027)." };
  if (!/^\d+$/.test(String(t.program_id || ""))) return { error: "Pick the Unearthed Program in HubSpot." };
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const deposit = num(t.deposit);
  if (deposit != null && !(deposit > 0)) return { error: "The deposit must be a positive amount (or blank to use the trip's payment schedule)." };
  const capacity = num(t.capacity);
  if (capacity != null && !(Number.isInteger(capacity) && capacity > 0)) return { error: "Capacity must be a whole number." };
  const currency = String(t.currency || "").trim().toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) return { error: "Currency must be a 3-letter code like NZD." };
  const closes = String(t.closes_on || "").trim() || null;
  if (closes && !/^\d{4}-\d{2}-\d{2}$/.test(closes)) return { error: "Closing date must be a date." };
  return { value: {
    slug, program_id: String(t.program_id), program_name: String(t.program_name || "").slice(0, 200) || null,
    school: String(t.school || "").trim().slice(0, 120) || null, destination: String(t.destination || "").trim().slice(0, 120) || null,
    open: t.open !== false, deposit, currency, capacity, closes_on: closes, note: String(t.note || "").slice(0, 500) || null,
  } };
}

async function tripSave(t, user) {
  const c = cleanTrip(t);
  if (c.error) return json({ error: c.error }, 400);
  const v = c.value;
  const original = String(t?.originalSlug || "").trim().toLowerCase();
  if (original && original !== v.slug) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ue_applications WHERE trip_slug = $1`, [original]);
    if (n) return json({ error: "This link already has applications, so its name can't change (links already sent would break). Close it and make a new one instead." }, 409);
    await q(`DELETE FROM ue_apply_trips WHERE slug = $1`, [original]);
  }
  const [row] = await q(
    `INSERT INTO ue_apply_trips (slug, program_id, program_name, school, destination, open, deposit, currency, capacity, closes_on, note, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug) DO UPDATE SET program_id = EXCLUDED.program_id, program_name = EXCLUDED.program_name, school = EXCLUDED.school,
       destination = EXCLUDED.destination, open = EXCLUDED.open, deposit = EXCLUDED.deposit, currency = EXCLUDED.currency,
       capacity = EXCLUDED.capacity, closes_on = EXCLUDED.closes_on, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [v.slug, v.program_id, v.program_name, v.school, v.destination, v.open, v.deposit, v.currency, v.capacity, v.closes_on, v.note, user.actor]);
  return json({ trip: row });
}

// ── applications ───────────────────────────────────────────────────────────

const LIST_COLS = `id, kind, role, approval IS NOT NULL AS approved, email, first_name, last_name, trip_slug, program_name, status, step1_at, step2_at, created_at, updated_at,
  hubspot_contact_id, hubspot_deal_id, jotform_submission_id, imported IS NOT NULL AS imported,
  waiver->>'status' AS waiver_status, waiver->>'sentTo' AS waiver_sent_to, waiver->>'signedAt' AS waiver_signed_at,
  deposit->>'status' AS deposit_status, deposit->>'amount' AS deposit_amount, deposit->>'currency' AS deposit_currency,
  (SELECT count(*)::int FROM jsonb_each(sync) s WHERE s.value->>'ok' = 'false') AS sync_errors`;

async function listApplications(url) {
  const params = [];
  const where = [];
  const trip = url.searchParams.get("trip");
  if (trip) { params.push(trip); where.push(`trip_slug = $${params.length}`); }
  const kind = url.searchParams.get("kind");
  if (kind === "student" || kind === "teacher") { params.push(kind); where.push(`kind = $${params.length}`); }
  const status = url.searchParams.get("status");
  if (status === "attention") where.push(`((SELECT count(*) FROM jsonb_each(sync) s WHERE s.value->>'ok' = 'false') > 0 OR (status IN ('applied','signed','paid') AND coalesce(waiver->>'status','') <> 'signed') OR (kind = 'teacher' AND step2_at IS NOT NULL AND approval IS NULL AND status <> 'withdrawn'))`);
  else if (status && status !== "all") { params.push(status); where.push(`status = $${params.length}`); }
  else if (!status) where.push(`status <> 'withdrawn'`);
  const text = String(url.searchParams.get("q") || "").trim().toLowerCase();
  if (text) { params.push(`%${text}%`); where.push(`(lower(email) LIKE $${params.length} OR lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) LIKE $${params.length})`); }
  const rows = await q(`SELECT ${LIST_COLS} FROM ue_applications ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`, params);
  const counts = Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM ue_applications ${trip ? "WHERE trip_slug = $1" : ""} GROUP BY status`, trip ? [trip] : [])).map((r) => [r.status, r.n]));
  return { applications: rows, counts };
}

async function getApplication(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { error: "Not found" };
  const [app] = await q(`SELECT id, kind, role, approval, email, first_name, last_name, trip_slug, program_id, program_name, status, answers, form_rev, step1_at, step2_at,
      waiver - 'signTokenHash' - 'text' AS waiver, (waiver_signature IS NOT NULL) AS has_signature, deposit, hubspot_contact_id, hubspot_parent_ids,
      hubspot_deal_id, jotform_submission_id, sync, imported, attribution, created_at, updated_at
    FROM ue_applications WHERE id = $1`, [id]);
  if (!app) return { error: "Not found" };
  const files = await q(`SELECT id, field_key, name, type, size, created_at FROM ue_apply_files WHERE app_id = $1 ORDER BY created_at`, [id]);
  return { app, files };
}

// ── ue-apply service calls ─────────────────────────────────────────────────

async function proxy(path, { method, body }) {
  const site = (process.env.UE_APPLY_SITE_URL || "").replace(/\/+$/, "");
  const key = process.env.UE_APPLY_SERVICE_KEY || process.env.APPLY_SERVICE_KEY;
  if (!site || !key) return json({ error: "Set UE_APPLY_SITE_URL and UE_APPLY_SERVICE_KEY on the dashboard site." }, 500);
  const r = await _fetch(`${site}${path}`, { method, headers: { "x-apply-key": key, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get("content-type") || "";
  if (type.includes("application/json")) return json(await r.json().catch(() => ({})), r.status);
  return new Response(await r.arrayBuffer(), { status: r.status, headers: { "Content-Type": type || "application/octet-stream", "Cache-Control": "private, no-store", ...(r.headers.get("content-disposition") ? { "Content-Disposition": r.headers.get("content-disposition") } : {}) } });
}
