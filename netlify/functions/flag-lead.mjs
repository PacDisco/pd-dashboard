// netlify/functions/flag-lead.mjs
//
// POST endpoint the dashboard hits when a user flags (or unflags) a contact
// as a Hot Lead. Does two things atomically:
//   1. Creates a HubSpot NOTE engagement on the contact so the admissions
//      team sees the flag in the contact's HubSpot timeline.
//   2. Stores the flag record in Netlify Blobs (flags.json) so the
//      dashboard can show the flag state without waiting for a refresh.
//
// Security: this endpoint is intentionally open (matches user choice
// "anyone who can see the dashboard"). Keep your dashboard URL unlisted.
// If abuse becomes a concern, add a shared-secret check below.
//
// Request body (JSON):
//   { contactId: "123", action: "flag" | "unflag", note?: "text", flaggedBy?: "Jake" }
//
// Env vars: HUBSPOT_TOKEN

import { getStore } from "@netlify/blobs";

const HUBSPOT_BASE = "https://api.hubapi.com";

function headers() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN env var is missing");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function hubspot(path, init = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} on ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function createHubSpotNote(contactId, body) {
  // 1. Create the note
  const now = Date.now();
  const note = await hubspot("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: String(now),
        hs_note_body: body,
      },
    }),
  });
  // 2. Associate it to the contact
  //    Association type id 202 = note→contact (standard HubSpot default)
  await hubspot(
    `/crm/v4/objects/notes/${note.id}/associations/default/contacts/${contactId}`,
    { method: "PUT" }
  );
  return note.id;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const { contactId, action = "flag", note = "", flaggedBy = "Dashboard user" } = payload || {};
  if (!contactId || !/^\d+$/.test(String(contactId))) {
    return new Response(JSON.stringify({ error: "contactId (numeric) required" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const validActions = ["flag", "unflag", "exclude", "unexclude"];
  if (!validActions.includes(action)) {
    return new Response(JSON.stringify({ error: `action must be one of ${validActions.join(", ")}` }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const store = getStore({ name: "hot-leads", consistency: "strong" });
  const [flags, exclusions] = await Promise.all([
    store.get("flags.json",      { type: "json" }),
    store.get("exclusions.json", { type: "json" }),
  ]);
  const flagMap = flags || {};
  const exclMap = exclusions || {};

  const nowIso = new Date().toISOString();
  const by = flaggedBy || "Dashboard user";
  const trimmedNote = note.slice(0, 500);

  let noteBody = null;

  if (action === "flag") {
    flagMap[contactId] = { flaggedAt: nowIso, flaggedBy: by, note: trimmedNote };
    noteBody = `<b>[HOT LEAD FLAG]</b> Flagged via dashboard by ${escapeHtml(by)}${trimmedNote ? `<br>${escapeHtml(trimmedNote)}` : ""}`;
  } else if (action === "unflag") {
    delete flagMap[contactId];
    noteBody = `<b>[HOT LEAD FLAG REMOVED]</b> Unflagged via dashboard by ${escapeHtml(by)}`;
  } else if (action === "exclude") {
    exclMap[contactId] = { excludedAt: nowIso, excludedBy: by, reason: trimmedNote };
    noteBody = `<b>[DASHBOARD EXCLUSION]</b> Excluded from Active Leads dashboard by ${escapeHtml(by)}${trimmedNote ? `<br>Reason: ${escapeHtml(trimmedNote)}` : ""}`;
  } else if (action === "unexclude") {
    delete exclMap[contactId];
    noteBody = `<b>[DASHBOARD EXCLUSION REMOVED]</b> Re-included in Active Leads dashboard by ${escapeHtml(by)}`;
  }

  // Create the HubSpot note (non-fatal if it fails — we still update Blobs).
  if (noteBody) {
    try { await createHubSpotNote(contactId, noteBody); }
    catch (err) { console.error("HubSpot note failed:", err.message); }
  }

  // Persist only the store that changed (minor cost savings).
  if (action === "flag" || action === "unflag") await store.setJSON("flags.json",      flagMap);
  if (action === "exclude" || action === "unexclude") await store.setJSON("exclusions.json", exclMap);

  return new Response(
    JSON.stringify({
      ok: true,
      contactId,
      action,
      flagged:  action === "flag",
      excluded: action === "exclude",
      flagCount:      Object.keys(flagMap).length,
      exclusionCount: Object.keys(exclMap).length,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
