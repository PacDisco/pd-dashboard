/**
 * netlify/functions/ue-applications.mjs
 *
 * Backs the "UE Applications" dashboard: assigning UE Application Form
 * submissions (matched to HubSpot contacts by email) to Unearthed Program
 * custom-object records, with association labels.
 *
 * Routes (query ?action=...):
 *   GET  ?action=meta
 *        -> { programs: [{id, name}], labels: [{category, typeId, label}] }
 *           `labels` are the contact -> program association types. The
 *           HUBSPOT_DEFINED unlabeled type is included (label: null).
 *
 *   POST ?action=assignments   { contactIds: ["123", ...] }
 *        -> { assignments: { [contactId]: [{ programId, types: [{category, typeId, label}] }] } }
 *
 *   POST ?action=assign        { contactId, programId, types: [{category, typeId}] }
 *        -> { ok: true }
 *           Empty/missing `types` creates the default (unlabeled) association.
 *
 *   POST ?action=unassign      { contactId, programId }
 *        -> { ok: true }   (removes the association and all its labels)
 *
 * Env vars:
 *   HUBSPOT_TOKEN            (required — same Private App token as elsewhere)
 *   UE_PROGRAM_OBJECT_TYPE   (default "2-58156993")
 *   UE_PROGRAM_NAME_PROP     (display-name property; auto-detected if unset)
 */

const HUBSPOT_API = "https://api.hubapi.com";
const PROGRAM_OBJECT_TYPE = process.env.UE_PROGRAM_OBJECT_TYPE || "2-58156993";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function token() {
  return process.env.HUBSPOT_TOKEN || null;
}

async function hsFetch(path, opts = {}) {
  return fetch(`${HUBSPOT_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function hsJson(path, opts = {}) {
  const resp = await hsFetch(path, opts);
  let body = null;
  try { body = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    const msg = (body && (body.message || body.error)) || `HubSpot HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Program display-name property — override with UE_PROGRAM_NAME_PROP,
// otherwise auto-detect (same approach as flight-tickets.js).
// ---------------------------------------------------------------------------
let _nameProp = null;
async function getProgramNameProp() {
  if (_nameProp) return _nameProp;
  if (process.env.UE_PROGRAM_NAME_PROP) { _nameProp = process.env.UE_PROGRAM_NAME_PROP; return _nameProp; }

  // 1. Authoritative: the object schema's primary display property.
  try {
    const schema = await hsJson(`/crm/v3/schemas/${PROGRAM_OBJECT_TYPE}`);
    if (schema && schema.primaryDisplayProperty) {
      _nameProp = schema.primaryDisplayProperty;
      return _nameProp;
    }
  } catch (_) {}

  // 2. Fallback: heuristic over property metadata.
  try {
    const data = await hsJson(`/crm/v3/properties/${PROGRAM_OBJECT_TYPE}`);
    const props = (data.results || []).filter((p) => !String(p.name).startsWith("hs_"));
    const strings = props.filter((p) => p.type === "string" || p.fieldType === "text");
    const pick = strings.find((p) => /program|name|title/i.test(p.name)) || strings[0] || props[0];
    if (pick) { _nameProp = pick.name; return _nameProp; }
  } catch (_) {}

  _nameProp = "name";
  return _nameProp;
}

// ---------------------------------------------------------------------------
// Programs list (cached for 5 min per warm lambda)
// ---------------------------------------------------------------------------
let _programs = { at: 0, data: null };
async function getPrograms() {
  if (_programs.data && Date.now() - _programs.at < 5 * 60 * 1000) return _programs.data;

  const nameProp = await getProgramNameProp();
  const programs = [];
  let after = null;

  do {
    const params = new URLSearchParams({ limit: "100", properties: nameProp });
    if (after) params.set("after", after);
    const page = await hsJson(`/crm/v3/objects/${PROGRAM_OBJECT_TYPE}?${params}`);
    for (const obj of page.results || []) {
      const name = (obj.properties || {})[nameProp];
      if (name) programs.push({ id: String(obj.id), name });
    }
    after = page.paging && page.paging.next ? page.paging.next.after : null;
  } while (after);

  programs.sort((a, b) => a.name.localeCompare(b.name));
  _programs = { at: Date.now(), data: programs };
  return programs;
}

// ---------------------------------------------------------------------------
// Association labels: contact -> program object
// ---------------------------------------------------------------------------
async function getLabels() {
  const data = await hsJson(`/crm/v4/associations/contacts/${PROGRAM_OBJECT_TYPE}/labels`);
  // results: [{ category, typeId, label }] — label is null for the unlabeled default.
  return (data.results || []).map((r) => ({
    category: r.category,
    typeId: r.typeId,
    label: r.label || null,
  }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleMeta() {
  const [programs, labels] = await Promise.all([getPrograms(), getLabels()]);
  return json(200, { programs, labels, objectType: PROGRAM_OBJECT_TYPE });
}

async function handleAssignments(body) {
  const ids = [...new Set((body.contactIds || []).map(String).filter((s) => /^\d+$/.test(s)))];
  if (!ids.length) return json(200, { assignments: {} });

  const assignments = {};
  for (const id of ids) assignments[id] = [];

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await hsJson(`/crm/v4/associations/contacts/${PROGRAM_OBJECT_TYPE}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }),
    });
    for (const r of data.results || []) {
      const fromId = r.from && String(r.from.id);
      if (!fromId) continue;
      assignments[fromId] = (r.to || []).map((t) => ({
        programId: String(t.toObjectId),
        types: (t.associationTypes || []).map((at) => ({
          category: at.category,
          typeId: at.typeId,
          label: at.label || null,
        })),
      }));
    }
  }

  return json(200, { assignments });
}

function validId(raw, label) {
  const s = String(raw || "").trim();
  if (!/^\d+$/.test(s)) throw Object.assign(new Error(`${label} must be a numeric id`), { status: 400 });
  return s;
}

async function handleAssign(body) {
  const contactId = validId(body.contactId, "contactId");
  const programId = validId(body.programId, "programId");
  const types = Array.isArray(body.types) ? body.types.filter((t) => t && t.typeId != null) : [];

  if (!types.length) {
    // Default (unlabeled) association.
    await hsJson(
      `/crm/v4/objects/contacts/${contactId}/associations/default/${PROGRAM_OBJECT_TYPE}/${programId}`,
      { method: "PUT" }
    );
  } else {
    await hsJson(
      `/crm/v4/objects/contacts/${contactId}/associations/${PROGRAM_OBJECT_TYPE}/${programId}`,
      {
        method: "PUT",
        body: JSON.stringify(
          types.map((t) => ({
            associationCategory: t.category || "USER_DEFINED",
            associationTypeId: Number(t.typeId),
          }))
        ),
      }
    );
  }

  return json(200, { ok: true });
}

async function handleUnassign(body) {
  const contactId = validId(body.contactId, "contactId");
  const programId = validId(body.programId, "programId");

  const resp = await hsFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/${PROGRAM_OBJECT_TYPE}/${programId}`,
    { method: "DELETE" }
  );
  if (!resp.ok && resp.status !== 204) {
    let msg = `HubSpot HTTP ${resp.status}`;
    try { const b = await resp.json(); msg = b.message || msg; } catch (_) {}
    return json(resp.status >= 500 ? 502 : resp.status, { error: msg });
  }

  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------
export default async (req) => {
  if (!token()) return json(500, { error: "HUBSPOT_TOKEN env var is not set" });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  let body = {};
  if (req.method === "POST") {
    try { body = await req.json(); }
    catch { return json(400, { error: "Invalid JSON body" }); }
    if (!action && body.action) {
      // allow action in body too
    }
  }
  const act = action || body.action || "";

  try {
    if (req.method === "GET" && act === "meta") return await handleMeta();
    if (req.method === "POST" && act === "assignments") return await handleAssignments(body);
    if (req.method === "POST" && act === "assign") return await handleAssign(body);
    if (req.method === "POST" && act === "unassign") return await handleUnassign(body);
    return json(400, { error: `Unknown action "${act}" for ${req.method}` });
  } catch (err) {
    console.error("ue-applications error:", err);
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return json(status, { error: err.message || String(err) });
  }
};
