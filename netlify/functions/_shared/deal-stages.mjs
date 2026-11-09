// netlify/functions/_shared/deal-stages.mjs
//
// Which stage an Unearthed Education student deal should be in, given what's
// been paid. Pure (no I/O) so the rules are unit-tested.
//
// "Unearthed Education" pipeline: Application Complete → Deposit Paid →
// Closed Won (+ Closed Lost). Stages are found by label, the same way pd-apply
// finds PD stages, so renaming "Deposit Paid" to "Deposit Received" still works.
//
//   paid ≥ deal amount (amount set)    → Closed Won
//   paid ≥ deposit                     → Deposit Paid
//     deposit = payment_amount_1 on the deal's trip record (or the global
//     default); when no deposit is set anywhere, any payment counts.
//
// Only ever forward. Never out of a Closed stage (Closed Won / Closed Lost),
// and never into Closed Lost — withdrawals stay a human decision.

export const STAGE_PATTERNS = {
  depositPaid: [/deposit\s*(paid|received)/i],
  closedWon: [/closed\s*won/i, /^won$/i, /paid\s*in\s*full/i],
};
const CLOSED = /closed|cancel|lost/i;
const TOLERANCE = 0.5; // dollars — rounding on converted / fee-stripped amounts

export function findStage(pipeline, kind) {
  const stages = [...(pipeline?.stages || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  for (const re of STAGE_PATTERNS[kind] || []) {
    const s = stages.find((x) => re.test(x.label || ""));
    if (s) return s;
  }
  return null;
}

/**
 * @param pipeline  { stages: [{ id, label, displayOrder }] }
 * @param deal      { stageId, amount, paid }
 * @param deposit   number | null
 * @returns { to: stage, from: stage|null, why } | null
 */
export function planStageMove(pipeline, { stageId, amount, paid }, deposit) {
  if (!pipeline?.stages?.length) return null;
  const cur = pipeline.stages.find((s) => String(s.id) === String(stageId)) || null;
  if (cur && CLOSED.test(cur.label)) return null;
  const p = Number(paid) || 0;
  if (p <= 0) return null;
  const amt = Number(amount) || 0;
  let target = null;
  let why = null;
  if (amt > 0 && p >= amt - TOLERANCE) { target = findStage(pipeline, "closedWon"); why = `paid ${fmt(p)} of ${fmt(amt)}`; }
  if (!target) {
    const dep = Number(deposit) > 0 ? Number(deposit) : null;
    if (dep == null || p >= dep - TOLERANCE) {
      target = findStage(pipeline, "depositPaid");
      why = dep == null ? `paid ${fmt(p)} (no deposit amount set on the trip)` : `paid ${fmt(p)}, deposit ${fmt(dep)}`;
    }
  }
  if (!target || String(target.id) === String(cur?.id)) return null;
  if (cur && (target.displayOrder ?? 0) <= (cur.displayOrder ?? 0)) return null;
  return { to: target, from: cur, why };
}

const fmt = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** "Application Complete → Deposit Paid" */
export const moveLabel = (m) => `${m.from?.label || "(no stage)"} → ${m.to.label}`;
