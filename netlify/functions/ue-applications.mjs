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
 *   POST ?action=create-contact  { email, firstname?, lastname?, phone? }
 *        -> { id, created: true|false }
 *           Creates the contact; if HubSpot reports the email already exists
 *           (race with another user), falls back to a search and returns the
 *           existing id with created: false.
 *
 *   POST ?action=link-family   { studentContactId, parentContactIds: [...] }
 *        -> { ok: true, label, dealsLinked, dealIds }
 *           Associates each parent contact to the student contact using the
 *           contact-to-contact label matching UE_PARENT_ASSOC_LABEL (or the
 *           first label matching /parent|guardian/i; unlabeled if none), then
 *           associates each parent to every deal the student is on (default
 *           contact->deal association).
 *
 *   POST ?action=family-links  { contactIds: [...] }
 *        -> { links: { [contactId]: ["<associatedContactId>", ...] } }
 *           Which contacts each given contact is already associated to
 *           (contact-to-contact) — used to show "linked" status in the UI.
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
// Family linking: parent contact -> student contact (+ student's deals)
// ---------------------------------------------------------------------------
let _ccLabels = { at: 0, data: null };
async function getContactContactLabels() {
  if (_ccLabels.data && Date.now() - _ccLabels.at < 5 * 60 * 1000) return _ccLabels.data;
  const data = await hsJson(`/crm/v4/associations/contacts/contacts/labels`);
  _ccLabels = { at: Date.now(), data: data.results || [] };
  return _ccLabels.data;
}

// Pick the label to use for parent -> student. Override with
// UE_PARENT_ASSOC_LABEL (exact, case-insensitive); otherwise the first
// contact-to-contact label matching /parent|guardian/i; otherwise null
// (default unlabeled association).
async function getParentAssocType() {
  const labels = await getContactContactLabels();
  const want = (process.env.UE_PARENT_ASSOC_LABEL || "").trim().toLowerCase();
  if (want) {
    const hit = labels.find((l) => (l.label || "").toLowerCase() === want);
    if (hit) return hit;
  }
  return labels.find((l) => /parent|guardian/i.test(l.label || "")) || null;
}

async function getContactDeals(contactId) {
  const dealIds = [];
  let after = null;
  do {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const page = await hsJson(`/crm/v4/objects/contacts/${contactId}/associations/deals?${params}`);
    for (const r of page.results || []) {
      if (r.toObjectId != null) dealIds.push(String(r.toObjectId));
    }
    after = page.paging && page.paging.next ? page.paging.next.after : null;
  } while (after);
  return [...new Set(dealIds)];
}

async function handleLinkFamily(body) {
  const studentId = validId(body.studentContactId, "studentContactId");
  const parentIds = [...new Set((body.parentContactIds || []).map(String).filter((s) => /^\d+$/.test(s)))]
    .filter((id) => id !== studentId);
  if (!parentIds.length) return json(400, { error: "parentContactIds is required" });

  const [parentType, dealIds] = await Promise.all([
    getParentAssocType(),
    getContactDeals(studentId),
  ]);

  for (const pid of parentIds) {
    // 1. parent -> student (labeled if a parent-ish label exists)
    if (parentType) {
      await hsJson(`/crm/v4/objects/contacts/${pid}/associations/contacts/${studentId}`, {
        method: "PUT",
        body: JSON.stringify([{
          associationCategory: parentType.category || "USER_DEFINED",
          associationTypeId: Number(parentType.typeId),
        }]),
      });
    } else {
      await hsJson(`/crm/v4/objects/contacts/${pid}/associations/default/contacts/${studentId}`, {
        method: "PUT",
      });
    }
    // 2. parent -> each of the student's deals (default association)
    for (const did of dealIds) {
      await hsJson(`/crm/v4/objects/contacts/${pid}/associations/default/deals/${did}`, {
        method: "PUT",
      });
    }
  }

  return json(200, {
    ok: true,
    label: parentType ? parentType.label : null,
    dealsLinked: dealIds.length,
    dealIds,
  });
}

async function handleFamilyLinks(body) {
  const ids = [...new Set((body.contactIds || []).map(String).filter((s) => /^\d+$/.test(s)))];
  if (!ids.length) return json(200, { links: {} });

  const links = {};
  for (const id of ids) links[id] = [];

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await hsJson(`/crm/v4/associations/contacts/contacts/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }),
    });
    for (const r of data.results || []) {
      const fromId = r.from && String(r.from.id);
      if (!fromId) continue;
      links[fromId] = (r.to || []).map((t) => String(t.toObjectId));
    }
  }

  return json(200, { links });
}

async function handleCreateContact(body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return json(400, { error: "A valid email is required" });
  }

  const properties = { email };
  for (const k of ["firstname", "lastname", "phone"]) {
    const v = String(body[k] || "").trim();
    if (v) properties[k] = v.slice(0, 200);
  }

  const resp = await hsFetch(`/crm/v3/objects/contacts`, {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
  let data = null;
  try { data = await resp.json(); } catch (_) {}

  if (resp.ok && data && data.id) {
    return json(200, { id: String(data.id), created: true });
  }

  // 409 = contact with this email already exists — look it up and return it.
  if (resp.status === 409) {
    const search = await hsJson(`/crm/v3/objects/contacts/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["email"],
        limit: 1,
      }),
    });
    const hit = (search.results || [])[0];
    if (hit) return json(200, { id: String(hit.id), created: false });
  }

  const msg = (data && (data.message || data.error)) || `HubSpot HTTP ${resp.status}`;
  return json(resp.status >= 500 ? 502 : resp.status || 502, { error: msg });
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
    if (req.method === "POST" && act === "create-contact") return await handleCreateContact(body);
    if (req.method === "POST" && act === "link-family") return await handleLinkFamily(body);
    if (req.method === "POST" && act === "family-links") return await handleFamilyLinks(body);
    return json(400, { error: `Unknown action "${act}" for ${req.method}` });
  } catch (err) {
    console.error("ue-applications error:", err);
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return json(status, { error: err.message || String(err) });
  }
};
