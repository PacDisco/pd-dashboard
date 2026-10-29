// netlify/functions/_shared/aircall.mjs
//
// Aircall for Lead Alerts (see LEAD-ALERTS.md → "Aircall"):
//
//   1. Webhook → when the advisor calls a lead (or a lead calls in and she
//      answers), the matching open alert closes itself with the call details.
//   2. Dial → "Send to Aircall on my computer" puts the number into her Aircall
//      desktop app ready to call (Aircall's dial API only works with the
//      desktop app/Workspace, not the phone app).
//
// Env: AIRCALL_API_ID, AIRCALL_API_TOKEN (Aircall → Integrations & API → API keys).
// The webhook is created from the app by an admin ("Connect Aircall"), and its
// verification token is stored in Neon (lead_alert_state 'aircall_webhook').
// AIRCALL_WEBHOOK_TOKEN overrides that if you made the webhook by hand.

import crypto from "node:crypto";

const BASE = "https://api.aircall.io/v1";
let _fetch = (...a) => fetch(...a);
export function _setAircallFetchForTests(f) { _fetch = f; }

export const WEBHOOK_PATH = "/api/aircall-webhook";
export const WEBHOOK_EVENTS = ["call.ended"];

export function aircallConfigured() {
  return !!(process.env.AIRCALL_API_ID && process.env.AIRCALL_API_TOKEN);
}

async function ac(path, { method = "GET", body } = {}) {
  if (!aircallConfigured()) throw Object.assign(new Error("Aircall API key not configured"), { status: 503 });
  const auth = Buffer.from(`${process.env.AIRCALL_API_ID}:${process.env.AIRCALL_API_TOKEN}`).toString("base64");
  const res = await _fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(`Aircall ${method} ${path}: HTTP ${res.status} ${(json?.message || json?.error || text).toString().slice(0, 200)}`);
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

// ── phone numbers ───────────────────────────────────────────────────────────

export const digitsOnly = (p) => String(p || "").replace(/\D/g, "");

/** Do two phone numbers refer to the same line? Compares the last 9 digits
 *  (7+ when one side is shorter), so country codes and a national leading 0
 *  don't matter: "+1 (555) 010-0100" = "5550100100", "+64 21 555 0199" = "021 555 0199". */
export function samePhone(a, b) {
  const x = digitsOnly(a), y = digitsOnly(b);
  if (x.length < 7 || y.length < 7) return false;
  const n = Math.min(9, x.length, y.length);
  return x.slice(-n) === y.slice(-n);
}

/** Best-effort E.164 for Aircall's dial API. US/Canada assumed for bare 10-digit numbers. */
export function toE164(p) {
  const raw = String(p || "").trim();
  const d = digitsOnly(raw);
  if (!d) return null;
  if (raw.startsWith("+")) return `+${d}`;
  if (raw.startsWith("00")) return `+${d.slice(2)}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}

// ── webhook ─────────────────────────────────────────────────────────────────

export function tokensMatch(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Aircall timestamps are Unix seconds; accept ms or ISO too. */
export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * What a finished Aircall call means for an open alert, or null if it doesn't
 * count as a follow-up. Outbound = she called them (answered or not — an
 * attempt within the hour counts). Inbound counts only if someone answered.
 */
export function followUpFromCall(call) {
  if (!call || !call.raw_digits) return null;
  const started = toMs(call.started_at);
  const answered = toMs(call.answered_at);
  const ended = toMs(call.ended_at);
  const talkMin = answered && ended ? Math.max(0, Math.round((ended - answered) / 60_000)) : 0;
  const who = call.user?.name || call.user?.email || "Aircall";
  if (call.direction === "outbound") {
    return {
      phone: call.raw_digits,
      at: new Date(started || Date.now()).toISOString(),
      by: who,
      how: answered ? `Called via Aircall · ${talkMin ? talkMin + " min call" : "under a minute"}` : "Called via Aircall · no answer",
    };
  }
  if (call.direction === "inbound" && answered) {
    return {
      phone: call.raw_digits,
      at: new Date(answered).toISOString(),
      by: who,
      how: `They called in · answered via Aircall${talkMin ? ` · ${talkMin} min` : ""}`,
    };
  }
  return null;
}

/** Create (or find) the Aircall webhook pointing at this site. Returns { id, token, url }. */
export async function ensureWebhook(siteUrl) {
  const url = `${String(siteUrl).replace(/\/+$/, "")}${WEBHOOK_PATH}`;
  const list = await ac("/webhooks?per_page=50");
  const existing = (list?.webhooks || []).find((w) => w.url === url);
  if (existing) {
    const full = existing.token ? existing : (await ac(`/webhooks/${existing.webhook_id || existing.id}`))?.webhook;
    return { id: String(full.webhook_id || full.id), token: full.token, url, created: false };
  }
  const made = await ac("/webhooks", { method: "POST", body: { custom_name: "PD Lead Alerts", url, events: WEBHOOK_EVENTS } });
  const w = made?.webhook || made;
  return { id: String(w.webhook_id || w.id), token: w.token, url, created: true };
}

// ── dial ────────────────────────────────────────────────────────────────────

/** Aircall user id for an email (case-insensitive). Pages through /users. */
export async function findUserId(email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return null;
  for (let page = 1; page <= 20; page++) {
    const r = await ac(`/users?per_page=50&page=${page}`);
    const hit = (r?.users || []).find((u) => String(u.email || "").toLowerCase() === want);
    if (hit) return String(hit.id);
    if (!r?.meta?.next_page_link) break;
  }
  return null;
}

/** Put `to` into the user's Aircall desktop app, ready to call. */
export async function dial(userId, to) {
  try {
    await ac(`/users/${encodeURIComponent(userId)}/dial`, { method: "POST", body: { to } });
  } catch (e) {
    if (e.httpStatus === 405) {
      throw Object.assign(new Error("Aircall says you're unavailable or already on a call. Open the Aircall app on your computer and set yourself to available."), { status: 409 });
    }
    if (e.httpStatus === 400) throw Object.assign(new Error(`Aircall couldn't use the number ${to}.`), { status: 400 });
    throw e;
  }
}
