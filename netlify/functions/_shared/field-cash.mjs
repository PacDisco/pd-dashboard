// netlify/functions/_shared/field-cash.mjs
//
// How much physical cash each instructor is holding.
//
// The ledger already knows: the field app records every movement of cash as
// well as every expense. Nothing stores a float — it is the net of what came
// into a pocket and what left it, which is the only version that can't drift
// from the entries it's derived from.
//
//   withdrawal   cash out of an ATM or a card, into a pocket
//   exchange     two rows sharing a group_id: negative in the currency given,
//                positive in the currency received
//   transfer     cash handed between people, signed the same way
//   expense      only when payment_method is 'cash'; a card charge never
//                touches the float
//
// Movement rows carry their own sign, so they are taken as they are rather than
// being negated by type. That is deliberate: it is the one rule that holds
// whichever way round the field app records a withdrawal, and an exchange is
// only representable as a signed pair anyway.
//
// Movements are then split by DIRECTION rather than netted, into `in` and
// `out`. Netting them is arithmetically identical and reads as a lie: an
// instructor who withdrew PEN 2,000 and changed PEN 1,000 into dollars would
// show "drawn 1,000", which matches no event they remember and no receipt. The
// caller must therefore group by sign as well — see budget-admin.mjs.
//
//   held = in − out − spent
//
// CORRECTIONS. A correction is a new row that voids an old one — the original
// with every signed figure negated (see FIELD-BUDGET.md). Its own entry_type is
// 'correction', which says nothing about what it is undoing, so the caller
// resolves `corrects_id` back to the original and passes the ORIGINAL's type and
// payment method as `kind` and `method`. The negated amount then flows through
// the same arithmetic and the float nets back on its own. A correction whose
// original is missing is counted as unresolved rather than guessed at.
//
// The float is held in the currency it was handed over in — `entries.currency`,
// not the leg currency — because that's what's physically in the pocket.
// Instructors routinely hold PEN and USD at once, so a person has one row per
// currency and the two are never added together.

/** Entry types that move cash in or out of a pocket, signed at source. */
export const CASH_MOVEMENT_TYPES = new Set(["withdrawal", "exchange", "transfer"]);

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function bucketFor(kind, method, amount) {
  if (CASH_MOVEMENT_TYPES.has(kind)) return amount < 0 ? "out" : "in";
  if (kind === "expense" && method === "cash") return "spent";
  return null; // card spend, or a type that doesn't touch cash
}

function slot(map, key, seed) {
  if (!map.has(key)) map.set(key, { ...seed, in: 0, out: 0, spent: 0, entries: 0 });
  return map.get(key);
}

/**
 * Fold the grouped ledger projection into cash positions.
 *
 * @param {Array<{budget_id,email,currency,kind,method,total,n}>} rows
 *   one row per (budget, person, currency, resolved type, payment method, sign),
 *   `total` already summed in minor units and `kind`/`method` already resolved
 *   through any correction.
 * @returns {{byBudget:Array, byPerson:Array, unresolved:number}}
 *   `in`, `out`, `spent` and `held` are minor units of `currency`, and `out` is
 *   a magnitude rather than a negative. `held` is in − out − spent and may
 *   legitimately come out negative: that means the ledger has more cash leaving
 *   than ever arrived, which is a missing withdrawal, not a negative pocket.
 */
export function foldCash(rows) {
  const budgets = new Map();
  const people = new Map();
  let unresolved = 0;

  for (const r of rows || []) {
    const email = r.email || "";
    const currency = r.currency || "";
    if (!email || !currency) continue;

    const amount = num(r.total);
    const bucket = bucketFor(r.kind, r.method, amount);
    if (!bucket) {
      // A correction that still reads as 'correction' means its original row
      // wasn't found, so there's no way to know which way it should net.
      if (r.kind === "correction") unresolved += num(r.n);
      continue;
    }

    const b = slot(budgets, `${r.budget_id}\u0000${email}\u0000${currency}`, {
      budget_id: r.budget_id, email, currency,
    });
    b[bucket] += bucket === "out" ? -amount : amount;
    b.entries += num(r.n);

    const p = slot(people, `${email}\u0000${currency}`, { email, currency });
    p[bucket] += bucket === "out" ? -amount : amount;
    p.entries += num(r.n);
  }

  const finish = (m) => [...m.values()]
    .map((x) => ({ ...x, held: x.in - x.out - x.spent }))
    .sort((a, b) =>
      (a.email || "").localeCompare(b.email || "") ||
      (a.currency || "").localeCompare(b.currency || ""));

  return { byBudget: finish(budgets), byPerson: finish(people), unresolved };
}

/**
 * What a whole budget's instructors are holding between them, per currency.
 * Currencies stay separate — adding PEN to USD would need a rate, and the point
 * of this figure is that it's countable rather than estimated.
 */
export function cashByCurrency(byBudget, budgetId) {
  const out = new Map();
  for (const row of byBudget || []) {
    if (budgetId !== undefined && row.budget_id !== budgetId) continue;
    const cur = out.get(row.currency) || { currency: row.currency, in: 0, out: 0, spent: 0, people: 0 };
    cur.in += row.in;
    cur.out += row.out;
    cur.spent += row.spent;
    cur.people += 1;
    out.set(row.currency, cur);
  }
  return [...out.values()]
    .map((c) => ({ ...c, held: c.in - c.out - c.spent }))
    .sort((a, b) => b.held - a.held || a.currency.localeCompare(b.currency));
}
