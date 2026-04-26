/**
 * netlify/functions/search-contacts.mjs
 *
 * Live HubSpot search. The dashboard calls this whenever the user has one
 * or more filters active. Always scoped to `company_tag = "Pacific Discovery"`.
 *
 * Request body (POST, JSON):
 *   {
 *     q?: string,           // optional free-text query (HubSpot default searchable props)
 *     filters?: [            // array of user-defined filters
 *       { prop: string, op: string, value?: any, value2?: any }
 *     ],
 *     limit?: number         // max rows to return (default 500, hard cap 2000)
 *   }
 *
 * Response: same shape as /.netlify/functions/contacts, with the additional
 * field `mode: "live"` and `truncated: true|false` if the result set was capped.
 *
 * Env required: HUBSPOT_TOKEN (Private App with crm.objects.contacts.read).
 */

import { getStore } from "@netlify/blobs";

const PORTAL_ID = 3855728;
const STORE_NAME = "pd-dashboard";
const BLOB_KEY = "snapshot";
const DEFAULT_LIMIT = 500;
const HARD_CAP = 2000;

const LIFECYCLE_LABELS = {
  subscriber: "Subscriber", lead: "Lead",
  marketingqualifiedlead: "Marketing Qualified Lead",
  salesqualifiedlead: "Sales Qualified Lead",
  opportunity: "Opportunity", customer: "Customer",
  "177210199": "Alumni", other: "Other", evangelist: "Evangelist"
};
const LEAD_STATUS_LABELS = {
  NEW: "New lead", "Qualifying call": "Qualifying call/email",
  Admissions: "Admissions", "Application Started": "Application Started",
  "Interview Complete": "Interview Complete", Unsuccessful: "Unsuccessful",
  Converted: "Customer", Alumni: "Alumni", Parent: "Parent",
  UNQUALIFIED: "Unqualified", Opportunity: "Opportunity",
  "Marketing Qualified": "Marketing Qualified",
  "Sales Qualified": "Sales Qualified", "Opted out": "Opted out",
  Subscriber: "Subscriber"
};

function requireToken() {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN env var is not set.");
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

// ---- Translate dashboard filters to HubSpot search filters ----------------

function translateFilter(f, schemaByName) {
  if (!f || !f.prop || !f.op) return null;
  const s = schemaByName[f.prop];
  const type = s?.type || "string";
  const v = f.value;
  const toStr = x => (x == null ? "" : String(x));
  const toTs = x => {
    if (x == null || x === "") return "";
    const d = new Date(x);
    return isNaN(d) ? "" : String(d.getTime());
  };

  switch (f.op) {
    case "is_empty":     return { propertyName: f.prop, operator: "NOT_HAS_PROPERTY" };
    case "is_not_empty": return { propertyName: f.prop, operator: "HAS_PROPERTY" };
    case "is_true":      return { propertyName: f.prop, operator: "EQ", value: "true" };
    case "is_false":     return { propertyName: f.prop, operator: "EQ", value: "false" };
    case "contains":
    case "not_contains": {
      const val = toStr(v).trim();
      if (!val) return null;
      return { propertyName: f.prop, operator: f.op === "contains" ? "CONTAINS_TOKEN" : "NOT_CONTAINS_TOKEN", value: val };
    }
    case "starts_with":
    case "ends_with":
    case "equals": {
      const val = toStr(v).trim();
      if (!val) return null;
      // HubSpot search has no native STARTS_WITH/ENDS_WITH — fall back to CONTAINS_TOKEN;
      // the browser still does its own strict post-filter via matches(), so results are correct.
      if (f.op === "equals") return { propertyName: f.prop, operator: "EQ", value: val };
      return { propertyName: f.prop, operator: "CONTAINS_TOKEN", value: val };
    }
    case "is_any_of":
    case "is_none_of": {
      const vals = Array.isArray(v) ? v.filter(x => x !== "" && x != null) : (v ? [v] : []);
      if (!vals.length) return null;
      return { propertyName: f.prop, operator: f.op === "is_any_of" ? "IN" : "NOT_IN", values: vals.map(String) };
    }
    case "eq":  return toStr(v) === "" ? null : { propertyName: f.prop, operator: "EQ", value: toStr(v) };
    case "ne":  return toStr(v) === "" ? null : { propertyName: f.prop, operator: "NEQ", value: toStr(v) };
    case "gt":  return toStr(v) === "" ? null : { propertyName: f.prop, operator: "GT", value: toStr(v) };
    case "gte": return toStr(v) === "" ? null : { propertyName: f.prop, operator: "GTE", value: toStr(v) };
    case "lt":  return toStr(v) === "" ? null : { propertyName: f.prop, operator: "LT", value: toStr(v) };
    case "lte": return toStr(v) === "" ? null : { propertyName: f.prop, operator: "LTE", value: toStr(v) };
    case "between": {
      if (toStr(v) === "" || toStr(f.value2) === "") return null;
      const isDate = type === "datetime" || type === "date";
      const lo = isDate ? toTs(v) : toStr(v);
      const hi = isDate ? toTs(f.value2) : toStr(f.value2);
      return { propertyName: f.prop, operator: "BETWEEN", value: lo, highValue: hi };
    }
    case "after":  return toTs(v) ? { propertyName: f.prop, operator: "GT", value: toTs(v) } : null;
    case "before": return toTs(v) ? { propertyName: f.prop, operator: "LT", value: toTs(v) } : null;
    case "in_last_days": {
      const n = parseInt(v, 10);
      if (isNaN(n)) return null;
      return { propertyName: f.prop, operator: "GTE", value: String(Date.now() - n * 86400000) };
    }
    case "older_than_days": {
      const n = parseInt(v, 10);
      if (isNaN(n)) return null;
      return { propertyName: f.prop, operator: "LT", value: String(Date.now() - n * 86400000) };
    }
  }
  return null;
}

// ---- HubSpot calls ---------------------------------------------------------

async function searchContactIds(token, filters, q, limit) {
  // We only need IDs here; properties come from the batch read.
  const ids = [];
  let after = "0";
  let total = null;
  while (ids.length < limit) {
    const body = {
      filterGroups: [{ filters }],
      properties: ["hs_object_id"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: Math.min(100, limit - ids.length),
      after
    };
    if (q) body.query = q;
    const data = await hsFetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      { method: "POST", body: JSON.stringify(body) },
      token
    );
    if (total === null) total = data.total ?? 0;
    for (const r of data.results || []) ids.push(String(r.id));
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    if (total != null && ids.length >= total) break;
  }
  return { ids, total: total || 0 };
}

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

// ---- Normalize (same shape as refresh-contacts) ---------------------------

const toInt = v => { if (v == null || v === "") return 0; const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const toFloat = v => { if (v == null || v === "") return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const toFloatOrNull = v => { if (v == null || v === "") return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

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
    props: p
  };
}

// ---- Handler --------------------------------------------------------------

export default async (req) => {
  const started = Date.now();
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Use POST" }), {
        status: 405,
        headers: { "content-type": "application/json" }
      });
    }
    const token = requireToken();

    const body = await req.json().catch(() => ({}));
    const userFilters = Array.isArray(body.filters) ? body.filters : [];
    const q = typeof body.q === "string" ? body.q.trim() : "";
    const limit = Math.min(HARD_CAP, Math.max(1, parseInt(body.limit, 10) || DEFAULT_LIMIT));

    // Pull schema from the cached snapshot (so we know each property's type).
    const store = getStore(STORE_NAME);
    const snapshot = (await store.get(BLOB_KEY, { type: "json" })) || {};
    const schema = Array.isArray(snapshot.schema) ? snapshot.schema : [];
    const groups = snapshot.groups || {};
    const schemaByName = Object.fromEntries(schema.map(s => [s.name, s]));

    // Build HubSpot filter list: always scope to Pacific Discovery.
    const hsFilters = [
      { propertyName: "company_tag", operator: "EQ", value: "Pacific Discovery" }
    ];
    if (userFilters.length === 0) {
      // No user filters → replicate the default snapshot scope (New Lead).
      hsFilters.push({ propertyName: "hs_lead_status", operator: "EQ", value: "NEW" });
    } else {
      for (const f of userFilters) {
        const hs = translateFilter(f, schemaByName);
        if (hs) hsFilters.push(hs);
      }
    }

    const { ids, total } = await searchContactIds(token, hsFilters, q, limit);
    const truncated = total > ids.length;

    // Decide which properties to batch-read. If schema is available, pull all
    // non-archived props (so the dashboard can sort by any field). Otherwise
    // fall back to a curated set.
    const propertyNames = schema.length
      ? schema.map(s => s.name)
      : [
          "firstname","lastname","email","phone","hubspot_owner_id",
          "lifecyclestage","hs_lead_status","createdate","lastmodifieddate",
          "jobtitle","company","country","city","state",
          "which_pacific_discovery_program_did_you_join_","program_interest",
          "program_dates","pacific_discovery_outreach_group",
          "how_did_you_hear_about_pacific_discovery",
          "num_associated_deals","total_revenue","recent_deal_amount",
          "recent_deal_close_date","hs_last_sales_activity_timestamp",
          "num_notes","num_contacted_notes","hs_analytics_num_visits",
          "hs_full_name_or_email"
        ];

    let rows = [];
    if (ids.length) {
      const contacts = await batchReadContacts(token, ids, propertyNames);
      const owners = await fetchOwners(token);
      rows = contacts.map(c => normalize(c, owners));
    }

    const payload = {
      mode: "live",
      generatedAt: new Date().toISOString(),
      filters: { company_tag: "Pacific Discovery", userFilters, q },
      total: rows.length,
      hubspotMatching: total,
      truncated,
      portalId: PORTAL_ID,
      schema,
      groups,
      rows,
      durationMs: Date.now() - started
    };

    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("search-contacts failed:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
};
