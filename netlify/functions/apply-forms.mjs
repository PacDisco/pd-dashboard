// netlify/functions/apply-forms.mjs
//
// API behind /apply-form/ — the editor for the online application served by
// the separate pd-apply site (apply.pacificdiscovery.org), plus the
// applications it collects. Both sites share this Neon database
// (MIGRATION-apply.sql): this function writes `apply_forms`; pd-apply reads
// the PUBLISHED copy and writes `applications`.
//
// Every route needs a verified Identity session with access to the Apply Form
// dashboard (see _shared/apply-form-access.mjs). Publishing needs a
// publishing role.
//
// Routes (GET ?action=…, POST JSON { action, … }):
//   GET  get                          → { form, user, lint }    (form = null until initialised)
//   POST init      { schema }         seed the form (only when none exists)
//   POST save      { rev, draft }     → { rev, lint } | 409 { conflict }
//   POST publish   { rev, note? }     → { publishedRev }
//   POST discard                      draft ← published
//   GET  versions                     → { versions }
//   POST restore   { versionId }      draft ← that version
//   GET  hubspot                      → { pdPrograms, contactProps, dealProps }
//   POST jotform-add { step, field }  create the question in the Jotform form → { qid, name }
//   GET  applications ?status=&q=&limit=
//   GET  application  ?id=            → full record (answers, sync)
//   POST resync    { id }             re-run Jotform/HubSpot sync via pd-apply
//   POST withdraw  { id, withdrawn }  hide/unhide an application from the portals
//   GET  file      ?id=               stream an uploaded file from pd-apply
//
// Env: NETLIFY_DATABASE_URL, HUBSPOT_TOKEN, JOTFORM_API_KEY,
//      APPLY_SITE_URL (https://apply.pacificdiscovery.org), APPLY_SERVICE_KEY,
//      APPLY_FORM_PUBLISH_ROLES (optional)

import { neon } from "@neondatabase/serverless";
import { requireEditor, json } from "./_shared/apply-form-access.mjs";
import { lintSchema, allFields, FIELD_TYPES } from "../../apply-form/form-kit.mjs";
import { lintQuiz, QUIZ_FORM_ID } from "../../apply-form/quiz-kit.mjs";

export const FORM_ID = "pd-application";
// ?form=quiz (GET) or { form: "quiz" } (POST) edits the gap-year quiz instead.
const formIdOf = (v) => (v === "quiz" ? QUIZ_FORM_ID : FORM_ID);
export const MAX_SCHEMA_BYTES = 768 * 1024;

let _sql;
function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}
export function __setSql(fn) { _sql = fn; }

// ── validation (pure) ──────────────────────────────────────────────────────

export function checkSchema(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "The form must be an object.";
  const size = Buffer.byteLength(JSON.stringify(s), "utf8");
  if (size > MAX_SCHEMA_BYTES) return `The form is too large (${Math.round(size / 1024)} KB).`;
  if (!Array.isArray(s.steps) || !s.steps.find((x) => x.key === "step1") || !s.steps.find((x) => x.key === "step2")) return "The form needs both steps.";
  if (!Array.isArray(s.programs) || !Array.isArray(s.terms)) return "Programs and travel dates are missing.";
  for (const { field } of allFields(s)) {
    if (!FIELD_TYPES[field.type]) return `Unknown field type "${field.type}".`;
    for (const k of ["html", "help", "label"]) {
      if (/<\s*script|javascript:/i.test(String(field[k] || ""))) return `"${field.label || field.key}" contains a script — remove it.`;
    }
  }
  const fee = Number(s.settings?.appFee);
  const rate = Number(s.settings?.cardFeeRate);
  if (!(fee > 0 && fee < 10000)) return "The application fee must be between $1 and $9,999.";
  if (!(rate >= 0 && rate < 0.2)) return "The card fee must be between 0% and 20%.";
  if (s.settings?.meetingUrl && !/^https:\/\/([a-z0-9-]+\.)*hubspot\.com\//i.test(s.settings.meetingUrl)) return "The interview link must be a HubSpot meetings link (https://meetings.hubspot.com/…).";
  return null;
}

export function checkQuiz(s) {
  if (!s || typeof s !== "object" || Array.isArray(s) || s.kind !== "quiz") return "The quiz must be an object with kind \"quiz\".";
  const size = Buffer.byteLength(JSON.stringify(s), "utf8");
  if (size > MAX_SCHEMA_BYTES) return `The quiz is too large (${Math.round(size / 1024)} KB).`;
  if (!Array.isArray(s.steps) || !s.steps.find((x) => x.key === "quiz") || !s.steps.find((x) => x.key === "contact")) return "The quiz needs its questions and details pages.";
  if (!Array.isArray(s.archetypes)) return "The quiz results are missing.";
  for (const { field } of allFields(s)) {
    if (!FIELD_TYPES[field.type]) return `Unknown field type "${field.type}".`;
    for (const k of ["html", "help", "label"]) if (/<\s*script|javascript:/i.test(String(field[k] || ""))) return `"${field.label || field.key}" contains a script — remove it.`;
  }
  for (const a of s.archetypes) if (/<\s*script|javascript:/i.test(String(a.html || ""))) return `"${a.name}" contains a script — remove it.`;
  if (s.settings?.hubspotFormGuid && !/^[0-9a-f-]{36}$/i.test(s.settings.hubspotFormGuid)) return "The HubSpot form ID should look like 1a2b3c4d-…-… (36 characters).";
  return null;
}

const lintFor = (id, s) => (id === QUIZ_FORM_ID ? lintQuiz(s) : lintSchema(s));
const checkFor = (id, s) => {
  if (id === QUIZ_FORM_ID) return checkQuiz(s);
  const err = checkSchema(s);
  if (err) return err;
  if (s.settings?.hubspotFormGuid && !/^[0-9a-f-]{36}$/i.test(s.settings.hubspotFormGuid)) return "The HubSpot form ID should look like 1a2b3c4d-…-… (36 characters).";
  return null;
};
const errorsOf = (id, s) => lintFor(id, s).filter((x) => x.level === "error");

function shape(row) {
  if (!row) return null;
  return {
    draft: row.draft,
    draftRev: row.draft_rev,
    published: row.published ? true : false,
    publishedRev: row.published_rev,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    changes: !row.published_rev || row.draft_rev > row.published_rev,
  };
}

async function loadRow(id = FORM_ID) {
  const rows = await db()`SELECT * FROM apply_forms WHERE id = ${id}`;
  return rows[0] || null;
}

// ── handler ────────────────────────────────────────────────────────────────

export default async (req, context, deps = {}) => {
  const user = await requireEditor(req, deps);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const action = url.searchParams.get("action") || "get";
      const fid = formIdOf(url.searchParams.get("form"));
      if (action === "get") {
        const row = await loadRow(fid);
        return json({ form: shape(row), user: { email: user.email, name: user.name, canPublish: user.canPublish }, lint: row ? lintFor(fid, row.draft) : [], applySite: applySite() });
      }
      if (action === "versions") {
        const rows = await db()`SELECT id, kind, rev, note, created_at, created_by FROM apply_form_versions WHERE form_id = ${fid} ORDER BY created_at DESC LIMIT 50`;
        return json({ versions: rows });
      }
      if (action === "hubspot") return json(await hubspotMeta());
      if (action === "applications") return json(await listApplications(url));
      if (action === "application") return json(await getApplication(url.searchParams.get("id")));
      if (action === "file") return await proxyFile(url.searchParams.get("id"));
      if (action === "quiz-responses") return json(await listQuizResponses(url));
      return json({ error: "Unknown action" }, 400);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const fid = formIdOf(body.form);
    switch (body.action) {
      case "init": return await init(body, user, fid);
      case "save": return await save(body, user, fid);
      case "publish": return await publish(body, user, fid);
      case "discard": return await discard(user, fid);
      case "restore": return await restore(body, user, fid);
      case "quiz-resync": return await quizResync(body);
      case "hubspot-form-create": return await hubspotFormCreate(body);
      case "jotform-add": return await jotformAdd(body);
      case "resync": return await resync(body);
      case "withdraw": return await withdraw(body);
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    console.error("[apply-forms]", err);
    return json({ error: err.publicMessage || err.message || "Server error" }, err.status || 500);
  }
};

async function init(body, user, fid = FORM_ID) {
  const err = checkFor(fid, body.schema);
  if (err) return json({ error: err }, 400);
  const rows = await db()`INSERT INTO apply_forms (id, draft, draft_rev, updated_by) VALUES (${fid}, ${JSON.stringify(body.schema)}, 1, ${user.actor})
    ON CONFLICT (id) DO NOTHING RETURNING *`;
  if (!rows[0]) return json({ error: "The form already exists — reload the page." }, 409);
  return json({ form: shape(rows[0]), lint: lintFor(fid, rows[0].draft) });
}

async function save(body, user, fid = FORM_ID) {
  const err = checkFor(fid, body.draft);
  if (err) return json({ error: err }, 400);
  const rev = Number(body.rev);
  const rows = await db()`UPDATE apply_forms SET draft = ${JSON.stringify(body.draft)}, draft_rev = draft_rev + 1,
      updated_at = now(), updated_by = ${user.actor}
    WHERE id = ${fid} AND draft_rev = ${rev} RETURNING draft_rev`;
  if (!rows[0]) {
    const cur = await loadRow(fid);
    return json({ error: "Someone else changed the form.", conflict: { rev: cur?.draft_rev, by: cur?.updated_by, at: cur?.updated_at } }, 409);
  }
  return json({ rev: rows[0].draft_rev, lint: lintFor(fid, body.draft) });
}

async function publish(body, user, fid = FORM_ID) {
  if (!user.canPublish) return json({ error: "You can edit the form but not publish it. Ask an admin or admissions lead." }, 403);
  const row = await loadRow(fid);
  if (!row) return json({ error: "Nothing to publish." }, 404);
  if (Number(body.rev) !== row.draft_rev) return json({ error: "The form changed since you loaded it — reload and try again.", conflict: { rev: row.draft_rev } }, 409);
  const errs = errorsOf(fid, row.draft);
  if (errs.length) return json({ error: `Fix these first: ${errs.map((e) => e.message).join(" ")}`, lint: errs }, 422);
  const note = String(body.note || "").slice(0, 300) || null;
  await db()`UPDATE apply_forms SET published = draft, published_rev = draft_rev, published_at = now(), published_by = ${user.actor} WHERE id = ${fid}`;
  await db()`INSERT INTO apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES (${fid}, 'publish', ${row.draft_rev}, ${JSON.stringify(row.draft)}, ${note}, ${user.actor})`;
  return json({ publishedRev: row.draft_rev, note: "Live within about 30 seconds." });
}

async function discard(user, fid = FORM_ID) {
  const rows = await db()`UPDATE apply_forms SET draft = published, draft_rev = draft_rev + 1, updated_at = now(), updated_by = ${user.actor}
    WHERE id = ${fid} AND published IS NOT NULL RETURNING *`;
  if (!rows[0]) return json({ error: "There is no published version to go back to." }, 409);
  return json({ form: shape(rows[0]), lint: lintFor(fid, rows[0].draft) });
}

async function restore(body, user, fid = FORM_ID) {
  const v = (await db()`SELECT data, rev FROM apply_form_versions WHERE id = ${Number(body.versionId)} AND form_id = ${fid}`)[0];
  if (!v) return json({ error: "Version not found." }, 404);
  const rows = await db()`UPDATE apply_forms SET draft = ${JSON.stringify(v.data)}, draft_rev = draft_rev + 1, updated_at = now(), updated_by = ${user.actor}
    WHERE id = ${fid} RETURNING *`;
  await db()`INSERT INTO apply_form_versions (form_id, kind, rev, data, note, created_by) VALUES (${fid}, 'restore', ${rows[0].draft_rev}, ${JSON.stringify(v.data)}, ${`Restored version from rev ${v.rev}`}, ${user.actor})`;
  return json({ form: shape(rows[0]), lint: lintFor(fid, rows[0].draft) });
}

// ── HubSpot metadata (for the Programs table and field mapping) ────────────

let _hsMeta = null;
async function hubspotMeta() {
  if (_hsMeta && Date.now() - _hsMeta.at < 10 * 60 * 1000) return _hsMeta.data;
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { pdPrograms: [], contactProps: [], dealProps: [], warning: "HUBSPOT_TOKEN is not set" };
  const get = async (p) => {
    const r = await fetch(`https://api.hubapi.com${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HubSpot ${p} → ${r.status}`);
    return r.json();
  };
  const [pd, contacts, deals] = await Promise.allSettled([
    get("/crm/v3/properties/deals/pd_program"),
    get("/crm/v3/properties/contacts"),
    get("/crm/v3/properties/deals"),
  ]);
  const writable = (r) => (r.status === "fulfilled" ? r.value.results || [] : [])
    .filter((p) => !p.modificationMetadata?.readOnlyValue && !p.calculated && !p.hidden)
    .map((p) => ({ name: p.name, label: p.label, type: p.type }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const data = {
    pdPrograms: pd.status === "fulfilled" ? (pd.value.options || []).filter((o) => !o.hidden).map((o) => ({ value: o.value, label: o.label })) : [],
    contactProps: writable(contacts),
    dealProps: writable(deals),
  };
  _hsMeta = { at: Date.now(), data };
  return data;
}

// ── Jotform: create a matching question while the mirror is on ─────────────

async function jotformAdd(body) {
  const key = process.env.JOTFORM_API_KEY;
  if (!key) return json({ error: "JOTFORM_API_KEY is not set" }, 500);
  const row = await loadRow();
  const formId = row?.draft?.settings?.jotform?.[body.step === "step1" ? "step1" : "step2"];
  if (!formId) return json({ error: "No Jotform form is set for that step." }, 400);
  const f = body.field || {};
  const type = FIELD_TYPES[f.type]?.jf;
  if (!type || f.type === "html") return json({ error: "That field type can't be created in Jotform." }, 400);
  const params = new URLSearchParams();
  params.append("question[type]", type);
  params.append("question[text]", String(f.label || f.key).slice(0, 500));
  params.append("question[name]", String(f.key).replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "field");
  params.append("question[required]", f.required ? "Yes" : "No");
  params.append("question[hidden]", "Yes"); // the field lives on pd-apply; in Jotform it only stores the answer
  if (Array.isArray(f.options) && f.options.length) params.append("question[options]", f.options.join("|"));
  const base = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
  const r = await fetch(`${base}/form/${encodeURIComponent(formId)}/questions?apiKey=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.content?.qid) return json({ error: `Jotform said: ${data?.message || r.status}` }, 502);
  return json({ qid: String(data.content.qid), name: data.content.name || f.key, type });
}

// ── applications ───────────────────────────────────────────────────────────

const LIST_COLS = `id, email, first_name, last_name, program, term, status, step1_at, step2_at, interview_at, interview, paid_at,
  payment, hubspot_contact_id, hubspot_deal_id, jotform_step1_id, jotform_step2_id, sync, created_at, updated_at`;

async function listApplications(url) {
  const status = url.searchParams.get("status") || "";
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10)));
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await db().query(
    `SELECT ${LIST_COLS} FROM applications
      WHERE ($1 = '' OR status = $1
             OR ($1 = 'needs_interview' AND interview->>'fallback' = 'true' AND interview_at IS NULL AND status <> 'withdrawn'))
        AND ($2 = '%%' OR lower(email) LIKE $2 OR lower(first_name || ' ' || last_name) LIKE $2 OR lower(program) LIKE $2)
      ORDER BY created_at DESC LIMIT $3`, [status, like, limit]);
  const counts = await db()`SELECT status, count(*)::int AS n FROM applications GROUP BY status`;
  const need = await db()`SELECT count(*)::int AS n FROM applications WHERE interview->>'fallback' = 'true' AND interview_at IS NULL AND status <> 'withdrawn'`;
  return { applications: rows.map(summary), counts: { ...Object.fromEntries(counts.map((c) => [c.status, c.n])), needs_interview: need[0]?.n || 0 } };
}

export function syncHealth(sync) {
  const s = sync || {};
  const problems = Object.entries(s).filter(([, v]) => v && v.ok === false).map(([k, v]) => `${k}: ${v.error}`);
  return { ok: problems.length === 0, problems };
}

function summary(r) {
  return {
    id: r.id, email: r.email, name: `${r.first_name || ""} ${r.last_name || ""}`.trim(), program: r.program, term: r.term,
    status: r.status, createdAt: r.created_at, step2At: r.step2_at, interviewAt: r.interview_at, interview: r.interview,
    paidAt: r.paid_at, payment: r.payment, hubspotDealId: r.hubspot_deal_id, hubspotContactId: r.hubspot_contact_id,
    jotformStep1Id: r.jotform_step1_id, jotformStep2Id: r.jotform_step2_id, sync: syncHealth(r.sync), syncRaw: r.sync,
  };
}

async function getApplication(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) throw Object.assign(new Error("Not found"), { status: 404 });
  const [row] = await db().query(`SELECT ${LIST_COLS}, answers, attribution FROM applications WHERE id = $1`, [id]);
  if (!row) throw Object.assign(new Error("Not found"), { status: 404 });
  const files = await db()`SELECT id, field_key, filename, content_type, size FROM apply_files WHERE application_id = ${id}`;
  return { application: { ...summary(row), answers: row.answers, attribution: row.attribution, files } };
}

function applySite() {
  return (process.env.APPLY_SITE_URL || "").replace(/\/+$/, "") || null;
}

async function resync({ id }) {
  const site = applySite();
  if (!site || !process.env.APPLY_SERVICE_KEY) return json({ error: "Set APPLY_SITE_URL and APPLY_SERVICE_KEY on the dashboard site." }, 500);
  const r = await fetch(`${site}/api/service/resync`, { method: "POST", headers: { "Content-Type": "application/json", "x-apply-key": process.env.APPLY_SERVICE_KEY }, body: JSON.stringify({ id }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: data.error || `pd-apply returned ${r.status}` }, 502);
  return json({ ok: true, result: data.result, application: data.app ? summary(data.app) : null });
}

async function withdraw({ id, withdrawn }) {
  const rows = await db().query(
    `UPDATE applications SET status = CASE WHEN $2 THEN 'withdrawn'
        WHEN paid_at IS NOT NULL THEN 'paid' WHEN interview_at IS NOT NULL THEN 'interview' WHEN step2_at IS NOT NULL THEN 'step2' ELSE 'step1' END,
      updated_at = now() WHERE id = $1 RETURNING ${LIST_COLS}`, [id, !!withdrawn]);
  if (!rows[0]) return json({ error: "Not found" }, 404);
  return json({ application: summary(rows[0]) });
}

async function proxyFile(id) {
  const site = applySite();
  if (!site || !process.env.APPLY_SERVICE_KEY) return json({ error: "Set APPLY_SITE_URL and APPLY_SERVICE_KEY." }, 500);
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return json({ error: "Not found" }, 404);
  const r = await fetch(`${site}/api/file/${id}`, { headers: { "x-apply-key": process.env.APPLY_SERVICE_KEY } });
  if (!r.ok) return json({ error: `File unavailable (${r.status})` }, r.status);
  return new Response(r.body, { headers: { "Content-Type": r.headers.get("content-type") || "application/octet-stream", "Content-Disposition": r.headers.get("content-disposition") || "inline", "Cache-Control": "private, max-age=300" } });
}

// ── quiz responses ─────────────────────────────────────────────────────────

async function listQuizResponses(url) {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10)));
  let rows;
  try {
    rows = await db().query(
      `SELECT id, email, first_name, last_name, phone, archetype, scores, answers, attribution, hubspot_contact_id, sync, created_at
         FROM quiz_responses
        WHERE ($1 = '%%' OR lower(email) LIKE $1 OR lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) LIKE $1)
        ORDER BY created_at DESC LIMIT $2`, [like, limit]);
  } catch (err) {
    if (/quiz_responses/.test(err.message)) return { responses: [], warning: "Run MIGRATION-quiz.sql in Neon to create the quiz_responses table." };
    throw err;
  }
  const counts = await db()`SELECT archetype, count(*)::int AS n FROM quiz_responses GROUP BY archetype`;
  return { responses: rows, counts: Object.fromEntries(counts.map((c) => [c.archetype, c.n])) };
}

async function quizResync({ id }) {
  const site = applySite();
  if (!site || !process.env.APPLY_SERVICE_KEY) return json({ error: "Set APPLY_SITE_URL and APPLY_SERVICE_KEY on the dashboard site." }, 500);
  const r = await fetch(`${site}/api/quiz/resync`, { method: "POST", headers: { "Content-Type": "application/json", "x-apply-key": process.env.APPLY_SERVICE_KEY }, body: JSON.stringify({ id, force: true }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: data.error || `pd-apply returned ${r.status}` }, 502);
  const [row] = await db().query(`SELECT id, email, first_name, last_name, archetype, hubspot_contact_id, sync, created_at FROM quiz_responses WHERE id = $1`, [id]);
  return json({ ok: true, result: data.result, response: row || null });
}

// ── HubSpot: create the form a page submits to (for Original Source) ───────
// Needs the `forms` scope on HUBSPOT_TOKEN. The form only needs the fields the
// site sends with the submission; everything else is written via the CRM API.

export function hubspotFormPayload(name) {
  const field = (n, label, fieldType, required) => ({ objectTypeId: "0-1", name: n, label, required, hidden: false, fieldType });
  return {
    name,
    formType: "hubspot",
    archived: false,
    fieldGroups: [
      { groupType: "default_group", richTextType: "text", fields: [field("email", "Email", "email", true)] },
      { groupType: "default_group", richTextType: "text", fields: [field("firstname", "First name", "single_line_text", false), field("lastname", "Last name", "single_line_text", false)] },
      { groupType: "default_group", richTextType: "text", fields: [field("phone", "Phone number", "phone", false)] },
    ],
    configuration: {
      language: "en", cloneable: true, editable: true, archivable: true, recaptchaEnabled: false,
      notifyContactOwner: false, notifyRecipients: [], createNewContactForNewEmail: false,
      prePopulateKnownValues: false, allowLinkToResetKnownValues: false, lifecycleStages: [],
      postSubmitAction: { type: "thank_you", value: "Thanks!" },
    },
    displayOptions: { renderRawHtml: false, theme: "default_style", submitButtonText: "Submit", style: {} },
    legalConsentOptions: { type: "none" },
  };
}

async function hubspotFormCreate(body) {
  const token = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) return json({ error: "HUBSPOT_TOKEN is not set" }, 500);
  const name = String(body.name || (body.form === "quiz" ? "Gap year quiz (apply.pacificdiscovery.org/quiz)" : "Application step 1 (apply.pacificdiscovery.org)")).slice(0, 120);
  const r = await fetch("https://api.hubapi.com/marketing/v3/forms/", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(hubspotFormPayload(name)) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id) {
    const scope = r.status === 403 ? " The HubSpot private app needs the “forms” scope — or create the form by hand (Marketing → Forms) with an Email field and paste its ID here." : "";
    return json({ error: `HubSpot said: ${data.message || r.status}.${scope}` }, 502);
  }
  return json({ id: data.id, name, editUrl: `https://app.hubspot.com/forms/${process.env.HUBSPOT_PORTAL_ID || "3855728"}/editor/${data.id}/edit/form` });
}
