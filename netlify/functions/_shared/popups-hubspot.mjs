// netlify/functions/_shared/popups-hubspot.mjs
//
// HubSpot calls for website popups: list contact properties (so the designer
// can map fields and load dropdown options) and create/update the contact
// that a popup submission belongs to.
//
// Env: POPUP_HUBSPOT_TOKEN (optional, a private app with contacts read/write +
//      notes write) — falls back to HUBSPOT_TOKEN, which the dashboard already uses.

import { hubspotProperties, noteText, HUBSPOT_TAG } from "./popups-core.mjs";
import { popupPdf } from "./submission-pdf.mjs";

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(status, path, body) {
    super(`HubSpot ${status} on ${path}: ${String(body).slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

function token() {
  const t = process.env.POPUP_HUBSPOT_TOKEN || process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error("HUBSPOT_TOKEN (or POPUP_HUBSPOT_TOKEN) is not set on this site.");
  return t;
}

export async function hubspot(path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new HubSpotError(res.status, path, text);
  return text ? JSON.parse(text) : {};
}

let _props = null;
let _propsAt = 0;

/** Contact properties a popup field could write to, with dropdown options. Cached 10 min. */
export async function contactProperties(fetchImpl) {
  if (_props && Date.now() - _propsAt < 10 * 60 * 1000) return _props;
  const data = await hubspot("/crm/v3/properties/contacts?archived=false", {}, fetchImpl);
  _props = (data.results || [])
    .filter((p) => !p.hidden && !p.calculated && !(p.modificationMetadata && p.modificationMetadata.readOnlyValue))
    .map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      group: p.groupName,
      options: (p.options || []).filter((o) => !o.hidden).map((o) => ({ label: o.label, value: o.value })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  _propsAt = Date.now();
  return _props;
}

/**
 * Create or update the contact for a popup submission.
 * @returns {{ id: string, created: boolean, dropped: string[] }}
 */
export async function upsertContact(popup, values, page, { fetchImpl, log = console } = {}) {
  const props = await contactProperties(fetchImpl).catch(() => null);
  const known = props ? new Map(props.map((p) => [p.name, p])) : null;
  const tagMeta = known?.get(HUBSPOT_TAG.property);
  const tagMulti = !!(tagMeta && tagMeta.fieldType === "checkbox");

  const found = await hubspot("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: values.email }] }],
      properties: ["email", "lifecyclestage", HUBSPOT_TAG.property],
      limit: 1,
    }),
  }, fetchImpl);
  const existing = found.results && found.results[0];

  let properties = hubspotProperties(popup, values, existing ? existing.properties : null, tagMulti);
  // Leave out properties HubSpot doesn't have, and dropdown values it wouldn't accept,
  // so one mis-mapped field can never lose the lead.
  const dropped = [];
  if (known) {
    for (const [k, v] of Object.entries(properties)) {
      const meta = known.get(k);
      if (!meta && !["email", "lifecyclestage"].includes(k)) { dropped.push(k); delete properties[k]; continue; }
      if (meta && meta.type === "enumeration" && meta.options.length && k !== HUBSPOT_TAG.property) {
        const ok = meta.fieldType === "checkbox"
          ? String(v).split(";").every((x) => meta.options.some((o) => o.value === x))
          : meta.options.some((o) => o.value === v);
        if (!ok) { dropped.push(`${k}=${v}`); delete properties[k]; }
      }
    }
  }

  const write = async (p) => existing
    ? hubspot(`/crm/v3/objects/contacts/${existing.id}`, { method: "PATCH", body: JSON.stringify({ properties: p }) }, fetchImpl)
    : hubspot("/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties: p }) }, fetchImpl);

  let saved;
  try {
    saved = await write(properties);
  } catch (e) {
    if (!(e instanceof HubSpotError) || e.status !== 400) throw e;
    // Retry with the essentials only, so the contact still lands in HubSpot.
    log.warn(`[popup-submit] full write refused, retrying with essentials: ${e.message}`);
    const keep = ["email", "firstname", "lastname", HUBSPOT_TAG.property, "hs_lead_status", "lifecyclestage"];
    const slim = Object.fromEntries(Object.entries(properties).filter(([k]) => keep.includes(k)));
    dropped.push(...Object.keys(properties).filter((k) => !keep.includes(k)));
    saved = await write(slim);
  }
  const id = String(saved.id || existing?.id);

  // The submission as a PDF, attached to the note below. Best effort: if the
  // upload fails (e.g. the token lacks the `files` scope) the note still goes on.
  let fileId = null;
  try {
    const pdf = popupPdf({ popup, values, page });
    fileId = await uploadPdf(pdf.bytes, pdf.fileName, fetchImpl);
  } catch (e) {
    log.warn(`[popup-submit] PDF not attached: ${e.message}`);
  }

  // Timeline note: which popup, which page, what they chose. Best effort.
  try {
    await hubspot("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: noteText(popup, values, page).replace(/\n/g, "<br>"),
          ...(fileId ? { hs_attachment_ids: fileId } : {}),
        },
        associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
      }),
    }, fetchImpl);
  } catch (e) {
    log.warn(`[popup-submit] note not added: ${e.message}`);
  }
  if (dropped.length) log.warn(`[popup-submit] ${popup.id}: left out ${dropped.join(", ")}`);
  return { id, created: !existing, dropped };
}

/** Upload a PDF to HubSpot Files (private) and return its id. Needs the `files` scope. */
export async function uploadPdf(bytes, fileName, fetchImpl = fetch) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
  form.append("fileName", fileName);
  form.append("folderPath", `${(process.env.FORM_PDF_FOLDER || "/Lead Forms").replace(/\/+$/, "")}/Website Popups`);
  form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false, duplicateValidationStrategy: "NONE" }));
  const res = await fetchImpl(`${BASE}/files/v3/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HubSpotError(res.status, "/files/v3/files", text);
  const id = JSON.parse(text || "{}").id;
  if (!id) throw new Error("HubSpot file upload returned no id");
  return String(id);
}
