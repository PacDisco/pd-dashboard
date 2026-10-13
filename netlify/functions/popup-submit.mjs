// netlify/functions/popup-submit.mjs
//
// PUBLIC. A visitor submitting a website popup. Writes the contact straight
// into HubSpot:
//   - creates the contact, or updates it if the email already exists
//   - company_tag = "Pacific Discovery", Lead status = New (every submission)
//   - Lifecycle stage = Lead, unless they're already further along
//     (HubSpot doesn't allow moving a contact backwards)
//   - the popup's fields go to the HubSpot properties chosen in the designer
//   - a note on the contact's timeline: which popup, which page, what they chose
//   - optionally, an email to the team (the popup's notification list), sent
//     through the connected Google Workspace mailbox, Reply-To = the visitor
//
// Request (JSON): { popup, fields: {email, firstname, …}, page: {uri, title}, website, t }
// (The popup also tells HubSpot's tracking code who the visitor is, so their
// page views on the site attach to the contact.)
//   website = honeypot (must be empty); t = ms since the popup appeared.
//
// Only accepted from the website's origins (POPUP_ALLOWED_ORIGINS, comma
// separated; default https://www.pacificdiscovery.org,https://pacificdiscovery.org).

import { checkSubmission, isEmail } from "./_shared/popups-core.mjs";
import { notificationEmail, sendMail } from "./_shared/popups-gmail.mjs";
import { readDoc, bumpStats, popupStore } from "./_shared/popups-store.mjs";
import { upsertContact } from "./_shared/popups-hubspot.mjs";

const DEFAULT_ORIGINS = "https://www.pacificdiscovery.org,https://pacificdiscovery.org";

export function allowedOrigins() {
  return (process.env.POPUP_ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function respond(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });
}

// Light per-instance throttle: 6 submissions a minute per IP.
const hits = new Map();
export function throttled(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 6;
}

export default async (req, context) => {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  const ok = allowedOrigins().includes(origin) ? origin : "";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: ok ? 204 : 403,
      headers: ok ? {
        "Access-Control-Allow-Origin": ok,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      } : {},
    });
  }
  if (req.method !== "POST") return respond({ error: "POST only." }, 405, ok);
  if (!ok) return respond({ error: "Not allowed from this site." }, 403, "");

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (throttled(ip)) return respond({ error: "Too many tries. Please wait a minute and try again." }, 429, ok);

  let body;
  try { body = await req.json(); } catch { return respond({ error: "Bad request." }, 400, ok); }

  // Bots: filled the hidden field, or submitted faster than a person can type.
  // Answer "ok" so they don't learn anything, and store nothing.
  if (body?.website || Number(body?.t) < 1500) return respond({ ok: true }, 200, ok);

  const store = popupStore();
  const doc = await readDoc(store);
  const popup = doc.popups.find((p) => p.id === body?.popup && p.enabled);
  if (!popup) return respond({ error: "This form is no longer available. Please refresh the page." }, 410, ok);

  const { errors, values } = checkSubmission(popup, body.fields || {});
  if (Object.keys(errors).length) return respond({ error: "Please check the highlighted fields.", errors }, 400, ok);

  const page = { uri: String(body.page?.uri || "").slice(0, 500), title: String(body.page?.title || "").slice(0, 200) };
  let contact = null;
  try {
    contact = await upsertContact(popup, values, page);
    console.log(`[popup-submit] ${popup.id} → contact ${contact.id} (${contact.created ? "new" : "updated"})`);
  } catch (e) {
    console.error("[popup-submit] HubSpot failed:", e.message);
  }
  const emailed = await notifyTeam(popup, values, page, contact, store);
  // If HubSpot was down but the team got the email, the lead isn't lost: tell the visitor it worked.
  if (!contact && !emailed) return respond({ error: "Sorry, something went wrong on our side. Please try again in a moment." }, 502, ok);
  await bumpStats(popup.id, store).catch(() => {});
  return respond({ ok: true }, 200, ok);
};

/** Email the popup's notification list through the connected Gmail mailbox. Never throws. */
export async function notifyTeam(popup, values, page, contact, store, deps = {}) {
  const to = (popup.notify?.emails || []).filter(isEmail);
  if (!to.length) return false;
  try {
    const conn = await store.get("gmail", { type: "json" });
    if (!conn?.refreshToken) { console.warn("[popup-submit] notifications on but no Gmail mailbox connected"); return false; }
    const msg = notificationEmail(popup, values, page, contact);
    await (deps.sendMail || sendMail)(conn, { to, replyTo: values.email, ...msg });
    if (conn.lastError) await store.setJSON("gmail", { ...conn, lastError: "" }).catch(() => {});
    return true;
  } catch (e) {
    console.error("[popup-submit] notification email failed:", e.message);
    // Shown in the designer, so someone notices a revoked or broken connection.
    try {
      const conn = await store.get("gmail", { type: "json" });
      if (conn) await store.setJSON("gmail", { ...conn, lastError: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${e.message.slice(0, 200)}` });
    } catch { /* ignore */ }
    return false;
  }
}
