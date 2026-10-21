// netlify/functions/_shared/hubspot-student.mjs
//
// The HubSpot calls the student-payments sync and the application PDFs need.
// Token: HUBSPOT_TOKEN (private app). Scopes: crm.objects.deals.read/write,
// crm.objects.contacts.read/write (notes are associated through these), files.
//
// STUDENT_PAYMENT_PIPELINES (optional, comma-separated pipeline ids) limits
// which deals name/email matching will consider. Defaults to the five
// pipelines the Enrollment dashboard shows. A deal id given explicitly (Stripe
// metadata, a reference) is accepted from any pipeline.

import { SLOT_PROPS, slotsOf, nameVariants, contactFits } from "./deal-payments.mjs";

const API = "https://api.hubapi.com";
export const DEFAULT_PIPELINES = ["694619955", "74958084", "74759274", "74958085", "74755425"];
export const DEAL_PROPS = ["dealname", "amount", "pipeline", "dealstage", "deal_currency_code", "total_amount_paid", "hs_is_closed_lost", "createdate", ...SLOT_PROPS];

export function pipelines(env = process.env) {
  const raw = String(env.STUDENT_PAYMENT_PIPELINES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_PIPELINES;
}

let _fetch = fetch;
export function __setFetch(f) { _fetch = f; }

async function hs(path, { method = "GET", body, raw = false } = {}) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await _fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1100 * (attempt + 1))); continue; }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (!res.ok) {
      const e = new Error(`HubSpot ${res.status} on ${method} ${path.split("?")[0]}: ${data?.message || "request failed"}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }
}

/** HubSpot deal record → the shape the matcher and queue use. */
export function toDeal(rec) {
  if (!rec) return null;
  const p = rec.properties || {};
  const slotSum = slotsOf(p).reduce((t, s) => t + (s.amount || 0), 0);
  const total = parseFloat(p.total_amount_paid);
  return {
    id: String(rec.id),
    name: p.dealname || "",
    amount: parseFloat(p.amount) || 0,
    paid: Number.isFinite(total) && total > 0 ? total : slotSum,
    pipeline: p.pipeline || null,
    currency: p.deal_currency_code || null,
    closedLost: p.hs_is_closed_lost === "true",
    props: p,
  };
}

export async function getDeal(id) {
  if (!/^\d{1,20}$/.test(String(id || ""))) return null;
  const qs = new URLSearchParams({ properties: DEAL_PROPS.join(",") });
  return toDeal(await hs(`/crm/v3/objects/deals/${id}?${qs}`));
}

export async function updateDeal(id, properties) {
  return hs(`/crm/v3/objects/deals/${id}`, { method: "PATCH", body: { properties } });
}

async function batchReadDeals(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await hs(`/crm/v3/objects/deals/batch/read`, {
      method: "POST",
      body: { properties: DEAL_PROPS, inputs: ids.slice(i, i + 100).map((id) => ({ id: String(id) })) },
    });
    out.push(...(data?.results || []).map(toDeal));
  }
  return out;
}

async function searchAll(object, body, maxPages = 25) {
  const out = [];
  let after;
  for (let page = 0; page < maxPages; page++) {
    const data = await hs(`/crm/v3/objects/${object}/search`, { method: "POST", body: { limit: 200, ...body, ...(after ? { after } : {}) } });
    out.push(...(data?.results || []));
    after = data?.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

const isOpenStudentDeal = (allowed) => (d) => d && !d.closedLost && allowed.includes(String(d.pipeline));

/** Open deals in the student pipelines created in the last 3 years. */
export async function openStudentDeals() {
  const allowed = pipelines();
  const since = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
  const recs = await searchAll("deals", {
    filterGroups: [{ filters: [
      { propertyName: "pipeline", operator: "IN", values: allowed },
      { propertyName: "createdate", operator: "GTE", value: since },
    ] }],
    properties: DEAL_PROPS,
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
  });
  return recs.map(toDeal).filter(isOpenStudentDeal(allowed));
}

async function dealsOfContacts(contactIds) {
  if (!contactIds.length) return [];
  const data = await hs(`/crm/v4/associations/contacts/deals/batch/read`, {
    method: "POST", body: { inputs: contactIds.slice(0, 50).map((id) => ({ id: String(id) })) },
  });
  const dealIds = [...new Set((data?.results || []).flatMap((r) => (r.to || []).map((t) => String(t.toObjectId))))];
  return (await batchReadDeals(dealIds.slice(0, 100))).filter(isOpenStudentDeal(pipelines()));
}

export async function dealsForEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return [];
  const recs = await searchAll("contacts", {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: e }] },
      { filters: [{ propertyName: "hs_additional_emails", operator: "CONTAINS_TOKEN", value: e }] },
    ],
    properties: ["email"],
  }, 1);
  return dealsOfContacts(recs.map((r) => r.id));
}

/**
 * Open student deals of the contact(s) whose name fits the bank's account-holder
 * name. "ROBERT J SMITH" finds contact Robert Smith; "SMITH, ROBERT" too; a
 * joint account finds either parent. Searched by word (case-insensitive), then
 * checked word-for-word with contactFits. More than 5 fitting contacts means
 * a common name, which is no evidence of anything.
 */
export async function dealsForPerson(fullName) {
  const variants = nameVariants(fullName).slice(0, 4);
  if (!variants.length) return [];
  const recs = await searchAll("contacts", {
    filterGroups: variants.map((v) => ({ filters: [
      { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: v.first },
      { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: v.last.split(" ").pop() },
    ] })),
    properties: ["firstname", "lastname"],
  }, 1);
  const fits = recs.filter((r) => contactFits(r.properties, variants));
  if (!fits.length || fits.length > 5) return [];
  return dealsOfContacts(fits.map((r) => r.id));
}

/** Free-text deal search for the review queue's "pick a deal" box. */
export async function searchDeals(q) {
  const text = String(q || "").trim().slice(0, 100);
  if (!text) return [];
  if (/^\d{6,20}$/.test(text)) { const d = await getDeal(text); return d ? [d] : []; }
  const data = await hs(`/crm/v3/objects/deals/search`, {
    method: "POST",
    body: { query: text, limit: 20, properties: DEAL_PROPS, sorts: [{ propertyName: "createdate", direction: "DESCENDING" }] },
  });
  return (data?.results || []).map(toDeal);
}

// ── files + notes (application PDFs) ───────────────────────────────────────

export async function uploadFile(bytes, fileName, folderPath = "/Student Applications") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
  form.append("fileName", fileName);
  form.append("folderPath", folderPath);
  form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false, duplicateValidationStrategy: "NONE" }));
  const data = await hs(`/files/v3/files`, { method: "POST", body: form });
  if (!data?.id) throw new Error("HubSpot file upload returned no id");
  return String(data.id);
}

// HUBSPOT_DEFINED association types: note → contact 202, note → deal 214.
export async function createNote({ body, fileId, contactId, dealId, timestamp }) {
  const associations = [];
  if (contactId) associations.push({ to: { id: String(contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] });
  if (dealId) associations.push({ to: { id: String(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] });
  const data = await hs(`/crm/v3/objects/notes`, {
    method: "POST",
    body: { properties: { hs_timestamp: timestamp || new Date().toISOString(), hs_note_body: body, hs_attachment_ids: String(fileId) }, associations },
  });
  if (!data?.id) throw new Error("HubSpot note create returned no id");
  return String(data.id);
}

export async function linkNoteToDeal(noteId, dealId) {
  return hs(`/crm/v4/objects/notes/${noteId}/associations/default/deals/${dealId}`, { method: "PUT" });
}
