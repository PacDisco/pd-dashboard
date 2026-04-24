/**
 * netlify/functions/refresh-contacts.mjs
 *
 * Pulls Pacific Discovery "New Lead" contacts from HubSpot and writes the
 * normalized dataset to Netlify Blobs under the key "snapshot".
 *
 * Fetches EVERY non-archived HubSpot contact property so the dashboard can
 * sort/filter on any field. Heavy properties are pulled in chunked batch
 * reads (100 IDs x 100 properties per call).
 *
 * Runs:
 *   - Scheduled every 4 hours (config.schedule "0 * / 4 * * *")
 *   - On demand via HTTP GET/POST to /.netlify/functions/refresh-contacts
 *
 * Env required: HUBSPOT_TOKEN (Private App access token).
 */

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "0 */4 * * *"
};

const PORTAL_ID = 3855728;
const STORE_NAME = "pd-dashboard";
const BLOB_KEY = "snapshot";

// Only used for the normalized display fields on each row; the raw "props"
// bag on each row contains every property fetched from HubSpot.
const LIFECYCLE_LABELS = {
  subscriber: "Subscriber",
  lead: "Lead",
  marketingqualifiedlead: "Marketing Qualified Lead",
  salesqualifiedlead: "Sales Qualified Lead",
  opportunity: "Opportunity",
  customer: "Customer",
  "177210199": "Alumni",
  other: "Other",
  evangelist: "Evangelist"
};

const LEAD_STATUS_LABELS = {
  NEW: "New lead",
  "Qualifying call": "Qualifying call/email",
  Admissions: "Admissions",
  "Application Started": "Application Started",
  "Interview Complete": "Interview Complete",
  Unsuccessful: "Unsuccessful",
  Converted: "Customer",
  Alumni: "Alumni",
  Parent: "Parent",
  UNQUALIFIED: "Unqualified",
  Opportunity: "Opportunity",
  "Marketing Qualified": "Marketing Qualified",
  "Sales Qualified": "Sales Qualified",
  "Opted out": "Opted out",
  Subscriber: "Subscriber"
};

// ---- HubSpot helpers -------------------------------------------------------

function requireToken() {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN env var is not set on this Netlify site.");
  return t;
}

async function hsFetch(url, options = {}, token) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} ${res.statusText} (${url}): ${body.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * All non-archived contact property definitions.
 * Returns: [{ name, label, type, fieldType, groupName }]
 */
async function fetchPropertySchema(token) {
  const data = await hsFetch(
    "https://api.hubapi.com/crm/v3/properties/contacts",
    {},
    token
  );
  return (data.results || [])
    .filter(p => !p.archived)
    .map(p => ({
      name: p.name,
      label: p.label || p.name,
      type: p.type || "string",
      fieldType: p.fieldType || "",
      groupName: p.groupName || "other"
    }));
}

/**
 * Property group definitions for pretty section labels in the sort UI.
 * Returns: { groupName: { label, order } }
 */
async function fetchPropertyGroups(token) {
  try {
    const data = await hsFetch(
      "https://api.hubapi.com/crm/v3/properties/contacts/groups",
      {},
      token
    );
    const map = {};
    for (const g of data.results || []) {
      map[g.name] = {
        label: g.label || g.name,
        order: typeof g.displayOrder === "number" ? g.displayOrder : 999
      };
    }
    return map;
  } catch (e) {
    return {};
  }
}

/**
 * Paginated search: returns just the IDs of matching contacts (light payload).
 */
async function searchContactIds(token) {
  const filterGroups = [{
    filters: [
      { propertyName: "company_tag", operator: "EQ", value: "Pacific Discovery" },
      { propertyName: "hs_lead_status", operator: "EQ", value: "NEW" }
    ]
  }];
  const ids = [];
  let after = "0";
  let total = null;
  while (true) {
    const body = {
      filterGroups,
      properties: ["hs_object_id"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 100,
      after
    };
    const data = await hsFetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      { method: "POST", body: JSON.stringify(body) },
      token
    );
    if (total === null) total = data.total;
    for (const r of data.results || []) ids.push(String(r.id));
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    if (total != null && ids.length >= total) break;
  }
  return ids;
}

/**
 * Batch-read every contact with the given property list.
 * Chunks both IDs (100 per call) and properties (100 per call),
 * merging results by contact id.
 */
async function batchReadContacts(token, ids, propertyNames) {
  const ID_CHUNK = 100;
  const PROP_CHUNK = 100;
  const propChunks = [];
  for (let i = 0; i < propertyNames.length; i += PROP_CHUNK) {
    propChunks.push(propertyNames.slice(i, i + PROP_CHUNK));
  }
  const merged = {};
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const idChunk = ids.slice(i, i + ID_CHUNK);
    const inputs = idChunk.map(id => ({ id }));
    for (const props of propChunks) {
      const data = await hsFetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
        { method: "POST", body: JSON.stringify({ inputs, properties: props }) },
        token
      );
      for (const r of data.results || []) {
        if (!merged[r.id]) merged[r.id] = { id: r.id, properties: {} };
        Object.assign(merged[r.id].properties, r.properties || {});
      }
    }
  }
  return Object.values(merged);
}

async function fetchOwners(token) {
  const map = {};
  let after;
  while (true) {
    const url = new URL("https://api.hubapi.com/crm/v3/owners");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const data = await hsFetch(url.toString(), {}, token);
    for (const o of data.results || []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || String(o.id);
      map[String(o.id)] = name;
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return map;
}

// ---- Row normalization -----------------------------------------------------

const toInt = v => { if (v == null || v === "") return 0; const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const toFloat = v => { if (v == null || v === "") return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const toFloatOrNull = v => { if (v == null || v === "") return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

/**
 * Produces both:
 *   - The normalized display fields used by the current table columns.
 *   - A `props` bag containing every raw HubSpot property value so the
 *     dashboard can sort on any one of them.
 */
function normalize(contact, owners) {
  const p = contact.properties || {};
  const ownerId = p.hubspot_owner_id || "";
  const lc = p.lifecyclestage || "";
  const ls = p.hs_lead_status || "";
  return {
    id: Number(contact.id),
    name: p.hs_full_name_or_email || `${p.firstname || ""} ${p.lastname || ""}`.trim(),
    firstname: p.firstname || "",
    lastname: p.lastname || "",
    email: p.email || "",
    phone: p.phone || "",
    company: p.company || "",
    jobtitle: p.jobtitle || "",
    country: p.country || "",
    city: p.city || "",
    state: p.state || "",
    owner_id: ownerId,
    owner_name: owners[ownerId] || ownerId || "",
    lifecyclestage: lc,
    lifecycle_label: LIFECYCLE_LABELS[lc] || lc,
    hs_lead_status: ls,
    lead_status_label: LEAD_STATUS_LABELS[ls] || ls,
    createdate: p.createdate || "",
    lastmodifieddate: p.lastmodifieddate || "",
    program_joined: p.which_pacific_discovery_program_did_you_join_ || "",
    program_interest: p.program_interest || "",
    program_dates: p.program_dates || "",
    outreach_group: p.pacific_discovery_outreach_group || "",
    heard_about: p.how_did_you_hear_about_pacific_discovery || "",
    num_associated_deals: toInt(p.num_associated_deals),
    total_revenue: toFloat(p.total_revenue),
    recent_deal_amount: toFloatOrNull(p.recent_deal_amount),
    recent_deal_close_date: p.recent_deal_close_date || "",
    hs_last_sales_activity_timestamp: p.hs_last_sales_activity_timestamp || "",
    num_notes: toInt(p.num_notes),
    num_contacted_notes: toInt(p.num_contacted_notes),
    hs_analytics_num_visits: toInt(p.hs_analytics_num_visits),
    // Raw properties bag — every field HubSpot returned, verbatim.
    props: p
  };
}

/**
 * Trims properties that are empty/null for every contact, so the sort UI
 * doesn't show useless options and the payload stays lean.
 */
function trimEmptyProps(schema, rows) {
  const hasValue = new Set();
  for (const r of rows) {
    const p = r.props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v != null && v !== "") hasValue.add(k);
    }
  }
  // Filter schema to only properties with at least one value somewhere.
  const trimmedSchema = schema.filter(s => hasValue.has(s.name));
  // Also drop empties from each row's props bag.
  for (const r of rows) {
    const p = r.props || {};
    const cleaned = {};
    for (const k of Object.keys(p)) {
      if (hasValue.has(k)) cleaned[k] = p[k];
    }
    r.props = cleaned;
  }
  return trimmedSchema;
}

// ---- Handler ---------------------------------------------------------------

export default async (req, context) => {
  const started = Date.now();
  try {
    const token = requireToken();

    const [schemaAll, groups] = await Promise.all([
      fetchPropertySchema(token),
      fetchPropertyGroups(token)
    ]);

    const ids = await searchContactIds(token);
    if (ids.length === 0) {
      throw new Error("No contacts matched the Pacific Discovery / New Lead filter.");
    }

    const propertyNames = schemaAll.map(s => s.name);
    const contacts = await batchReadContacts(token, ids, propertyNames);

    const owners = await fetchOwners(token);
    const rows = contacts.map(c => normalize(c, owners));

    const schema = trimEmptyProps(schemaAll, rows);

    const payload = {
      generatedAt: new Date().toISOString(),
      filters: { company_tag: "Pacific Discovery", hs_lead_status: "NEW" },
      total: rows.length,
      portalId: PORTAL_ID,
      groups,     // { groupName: { label, order } }
      schema,     // [{ name, label, type, fieldType, groupName }, ...]
      rows        // each row has normalized fields + a `props` bag
    };

    const store = getStore(STORE_NAME);
    await store.setJSON(BLOB_KEY, payload);

    const out = {
      ok: true,
      total: rows.length,
      propertiesCount: schema.length,
      generatedAt: payload.generatedAt,
      durationMs: Date.now() - started
    };
    console.log("refresh-contacts:", out);
    return new Response(JSON.stringify(out), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("refresh-contacts failed:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};
