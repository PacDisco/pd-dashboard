// netlify/functions/_shared/payment-sources.mjs
//
// Read-only fetchers for the student payment sync: recent Stripe charges,
// recent Wise incoming payments, and the USD rate on a given day.
//
// Env:
//   STUDENT_PAYMENTS_STRIPE_KEYS  optional, "label:sk_…,label2:rk_…" — one per
//                                 Stripe account to watch. Defaults to
//                                 STRIPE_SECRET_KEY (label "stripe"). A
//                                 restricted key with Charges + PaymentIntents
//                                 + Customers READ is enough.
//   WISE_API_TOKEN                Wise personal/business API token (read only)
//   WISE_PROFILE_ID               the business profile id
//   WISE_API_BASE                 optional, default https://api.wise.com

import { formatAmount } from "./deal-payments.mjs";

const STRIPE_API = "https://api.stripe.com/v1";

export function stripeAccounts(env = process.env) {
  const raw = String(env.STUDENT_PAYMENTS_STRIPE_KEYS || "").trim();
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s, i) => {
      const at = s.indexOf(":");
      return at > 0 && !s.startsWith("sk_") && !s.startsWith("rk_")
        ? { label: s.slice(0, at).trim(), key: s.slice(at + 1).trim() }
        : { label: `stripe${i ? i + 1 : ""}`, key: s };
    });
  }
  return env.STRIPE_SECRET_KEY ? [{ label: "stripe", key: env.STRIPE_SECRET_KEY }] : [];
}

/** Every succeeded charge created since `sinceSec` (unix seconds), newest first. */
export async function listStripeCharges({ key, sinceSec, maxPages = 5, fetchImpl = fetch }) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: "100", "created[gte]": String(sinceSec) });
    qs.append("expand[]", "data.payment_intent");
    qs.append("expand[]", "data.customer");
    if (after) qs.set("starting_after", after);
    const res = await fetchImpl(`${STRIPE_API}/charges?${qs}`, {
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${body?.error?.message || "request failed"}`);
    out.push(...(body.data || []));
    if (!body.has_more || !body.data?.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out;
}

function wiseBase(env = process.env) {
  return String(env.WISE_API_BASE || "https://api.wise.com").replace(/\/+$/, "");
}

async function wiseGet(path, env, fetchImpl) {
  const res = await fetchImpl(`${wiseBase(env)}${path}`, {
    headers: { Authorization: `Bearer ${env.WISE_API_TOKEN}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 403 && res.headers.get("x-2fa-approval")) {
    throw new Error("Wise asked for strong customer authentication on balance statements. This token can't read statements without a signing key — see STUDENT-PAYMENTS.md › Wise.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Wise ${res.status} on ${path.split("?")[0]}: ${body?.errors?.[0]?.message || body?.error || "request failed"}`);
  return body;
}

/**
 * Credits on every Wise balance between `since` and now. Returns
 * [{ balance: { id, currency }, transactions: [...] }].
 */
export async function listWiseCredits({ since, env = process.env, fetchImpl = fetch }) {
  if (!env.WISE_API_TOKEN || !env.WISE_PROFILE_ID) return [];
  const profile = encodeURIComponent(env.WISE_PROFILE_ID);
  const balances = await wiseGet(`/v4/profiles/${profile}/balances?types=STANDARD`, env, fetchImpl);
  const end = new Date().toISOString();
  const start = new Date(since).toISOString();
  const out = [];
  for (const b of balances || []) {
    const qs = new URLSearchParams({ currency: b.currency, intervalStart: start, intervalEnd: end, type: "COMPACT" });
    const st = await wiseGet(`/v1/profiles/${profile}/balance-statements/${encodeURIComponent(b.id)}/statement.json?${qs}`, env, fetchImpl);
    out.push({ balance: { id: b.id, currency: b.currency }, transactions: st?.transactions || [] });
  }
  return out;
}

// ── FX ──────────────────────────────────────────────────────────────────────

const _fx = new Map();

/**
 * Rate to multiply `currency` by to get USD, on `date` (YYYY-MM-DD). ECB
 * reference rate via Frankfurter (falls back to the previous business day on
 * weekends); latest open rate if that fails. Not a dealing rate — the ledger
 * keeps the original amount and the rate used so it can be checked.
 */
export async function usdRate(currency, date, { fetchImpl = fetch } = {}) {
  const cur = String(currency || "").toUpperCase();
  if (cur === "USD") return 1;
  const k = `${cur}:${date}`;
  if (_fx.has(k)) return _fx.get(k);
  let rate = null;
  try {
    const r = await fetchImpl(`https://api.frankfurter.dev/v1/${date}?base=${cur}&symbols=USD`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) rate = Number((await r.json())?.rates?.USD) || null;
  } catch { /* fall through */ }
  if (!rate) {
    try {
      const r = await fetchImpl(`https://open.er-api.com/v6/latest/${cur}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) rate = Number((await r.json())?.rates?.USD) || null;
    } catch { /* none */ }
  }
  if (!rate) throw new Error(`No ${cur}→USD rate for ${date}`);
  _fx.set(k, rate);
  return rate;
}

export function toUsd(amount, rate) {
  return Number(formatAmount(amount * rate));
}
