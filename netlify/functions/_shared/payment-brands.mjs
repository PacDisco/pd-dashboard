// netlify/functions/_shared/payment-brands.mjs
//
// Which brands the student payment sync runs for, and where each one's money
// comes in. Each brand has its own Stripe account, its own Wise account and
// its own deal pipelines — a payment is only ever matched against deals of the
// brand whose account received it.
//
//   pd  Pacific Discovery. Unchanged from before brands existed: the same env
//       vars, live from day one, no stage moves (pd-apply moves PD stages).
//   ue  Unearthed Education. Stripe: UE_STUDENT_PAYMENTS_STRIPE_KEYS, else the
//       STRIPE_SECRET_KEY_UNEARTHED the UE Stripe dashboard already uses.
//       Wise: UE_WISE_API_TOKEN (+ UE_WISE_PROFILE_ID if the token sees more
//       than one business profile). Deals: the "Unearthed Education" pipeline.
//       Starts in WATCH mode — see STUDENT-PAYMENTS.md › Unearthed Education.
//
// Env per brand (PD name → UE name):
//   STUDENT_PAYMENTS_STRIPE_KEYS → UE_STUDENT_PAYMENTS_STRIPE_KEYS
//   STRIPE_SECRET_KEY            → STRIPE_SECRET_KEY_UNEARTHED
//   WISE_API_TOKEN               → UE_WISE_API_TOKEN
//   WISE_PROFILE_ID              → UE_WISE_PROFILE_ID
//   STUDENT_PAYMENT_PIPELINES    → UE_STUDENT_PAYMENT_PIPELINES  (default 836668844)
//   STUDENT_PAYMENTS_START       → UE_STUDENT_PAYMENTS_START
//   STRIPE_CARD_FEE_RATE (0.035) → UE_STRIPE_CARD_FEE_RATE (0.03)
//   —                            → UE_STUDENT_PAYMENTS_MODE  watch (default) | live | off
//
// UE payments are credited in the currency they arrive in (no conversion);
// PD payments are converted to USD.

import { stripeAccounts as pdStripeAccounts } from "./payment-sources.mjs";
import { pipelines as pdPipelines } from "./hubspot-student.mjs";

export const UE_PIPELINE = "836668844"; // HubSpot deal pipeline "Unearthed Education"
export const BRAND_LABELS = { pd: "Pacific Discovery", ue: "Unearthed Education" };
export const BRAND_KEYS = Object.keys(BRAND_LABELS);

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const rate = (v, dflt) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : dflt; };
const mode = (v, dflt) => (["live", "watch", "off"].includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : dflt);

/** "label:key,key2" → [{ label, key }] (same format as STUDENT_PAYMENTS_STRIPE_KEYS). */
export function parseStripeKeys(raw, fallbackLabel) {
  return list(raw).map((s, i) => {
    const at = s.indexOf(":");
    return at > 0 && !s.startsWith("sk_") && !s.startsWith("rk_")
      ? { label: s.slice(0, at).trim(), key: s.slice(at + 1).trim() }
      : { label: `${fallbackLabel}${i ? i + 1 : ""}`, key: s };
  });
}

/**
 * @param env      process.env (or a test object)
 * @param sources  { stripeAccounts } — PD's Stripe accounts come from here so
 *                 tests that fake stripeAccounts keep working.
 * @returns [{ key, label, mode, stripeAccounts, wiseEnv, wiseAlways, pipelines,
 *            strictPipelines, surchargeRate, stages, start }]
 */
export function brandConfigs(env = process.env, sources = {}) {
  const pd = {
    key: "pd",
    label: BRAND_LABELS.pd,
    mode: "live",
    stripeAccounts: (sources.stripeAccounts || (() => pdStripeAccounts(env)))(),
    wiseEnv: env,
    // PD has always asked Wise even with no token (listWiseCredits returns []).
    wiseAlways: true,
    pipelines: pdPipelines(env),
    // A PD deal id in metadata / a reference is accepted from any pipeline
    // (Pure Exploration etc.) — unchanged behaviour.
    strictPipelines: false,
    surchargeRate: rate(env.STRIPE_CARD_FEE_RATE, 0.035),
    stages: false,
    // PD deals are kept in USD: other currencies are converted (ECB rate).
    creditAsReceived: false,
    start: env.STUDENT_PAYMENTS_START || "",
  };
  const ueStripe = env.UE_STUDENT_PAYMENTS_STRIPE_KEYS
    ? parseStripeKeys(env.UE_STUDENT_PAYMENTS_STRIPE_KEYS, "ue")
    : env.STRIPE_SECRET_KEY_UNEARTHED ? [{ label: "ue", key: env.STRIPE_SECRET_KEY_UNEARTHED }] : [];
  const ue = {
    key: "ue",
    label: BRAND_LABELS.ue,
    mode: mode(env.UE_STUDENT_PAYMENTS_MODE, "watch"),
    stripeAccounts: ueStripe,
    wiseEnv: env.UE_WISE_API_TOKEN
      ? { WISE_API_TOKEN: env.UE_WISE_API_TOKEN, WISE_PROFILE_ID: env.UE_WISE_PROFILE_ID || "", WISE_API_BASE: env.WISE_API_BASE || "" }
      : null,
    wiseAlways: false,
    pipelines: list(env.UE_STUDENT_PAYMENT_PIPELINES).length ? list(env.UE_STUDENT_PAYMENT_PIPELINES) : [UE_PIPELINE],
    // UE money must land on a UE student deal. A deal id pointing anywhere
    // else (a school deal in "UE School Expeditions", a PD deal) goes to review.
    strictPipelines: true,
    surchargeRate: rate(env.UE_STRIPE_CARD_FEE_RATE, 0.03),
    stages: true,
    // UE deals and the portal's payment schedule are in the trip's own
    // currency (program_currency, e.g. NZD): a payment is credited as received,
    // never converted, so "paid" lines up with the schedule the portal shows.
    creditAsReceived: true,
    start: env.UE_STUDENT_PAYMENTS_START || "",
  };
  return [pd, ue].filter((b) => b.mode !== "off");
}

/** Is there anything to read for this brand? (UE before its env vars are set: no.) */
export function brandConfigured(b) {
  return b.stripeAccounts.length > 0 || b.wiseAlways || !!b.wiseEnv?.WISE_API_TOKEN;
}
