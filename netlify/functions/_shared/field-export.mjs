// netlify/functions/_shared/field-export.mjs
//
// The reconciliation CSV: every entry converted to the base currency (NZD),
// with totals.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO NZD COLUMNS, AND WHY THAT ISN'T FUSSINESS
//
// A converted figure and a known one are different facts, and this file refuses
// to print them as the same number.
//
//   actual_nzd    what the money really cost. Card charges land on the NZD
//                 account at the bank's rate; cash was bought at a known cost
//                 at an ATM or a counter. Filled in at reconciliation, so it is
//                 blank until someone does that.
//
//   nzd_estimate  the leg amount converted at the leg's PLANNING rate — the
//                 rate someone typed in when the budget was set up, weeks
//                 before the money moved. It is an estimate and is named one.
//
//   nzd           actual_nzd when it exists, otherwise the estimate. One column
//                 to sum, which is what a spreadsheet actually needs.
//   nzd_source    `actual` or `estimate` for that row, so a total that leans on
//                 guesses can be told from one that doesn't.
//
// FIELD-BUDGET.md puts it plainly: programme cost in NZD is the sum of funding
// events, which is exact. Converting each expense estimates a number you will
// later have precisely. The estimate is genuinely useful — you cannot wait for
// reconciliation to see roughly where a programme sits — but presenting it as
// the truth is how an estimate quietly becomes a reported figure.
//
// Rates: a leg's `rates` map is leg-currency units per 1 unit of the other
// currency, so converting the leg's own amount INTO the base means dividing.
// A leg with no base rate yields a blank rather than a zero, and its rows say
// so in nzd_source.
//
// Cash movements carry no budget_amount, so they get no estimate: a withdrawal
// is a funding event, and its true cost belongs in actual_nzd rather than being
// inferred from a planning rate. They still appear as rows, and still carry
// actual_nzd when it has been filled in.

const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const decimals = (cur) =>
  ZERO_DECIMAL.has(cur) ? 0 : (THREE_DECIMAL.has(cur) ? 3 : 2);

export const minorUnits = (cur) => Math.pow(10, decimals(cur));

export const asDecimal = (minorAmount, cur) =>
  (Number(minorAmount || 0) / minorUnits(cur)).toFixed(decimals(cur));

/** Entry types that move cash rather than spending it. */
const MOVEMENT = new Set(["withdrawal", "exchange", "transfer"]);

/**
 * Convert minor units of a leg currency into minor units of the base currency.
 *
 * Returns null when it can't be done — no rate for the base, a junk rate, or no
 * leg currency at all. Null is a blank cell, never a zero: a zero would sum
 * silently into a total and understate it.
 */
export function toBaseMinor(minorInLeg, legCurrency, rates, base) {
  if (minorInLeg === null || minorInLeg === undefined) return null;
  const leg = String(legCurrency || "").toUpperCase();
  const to = String(base || "NZD").toUpperCase();
  if (!leg) return null;
  if (leg === to) return Math.round(Number(minorInLeg));

  const rate = Number((rates || {})[to]);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  // Whole-unit maths, then back to the base's minor units, so a leg in a
  // zero-decimal currency (CLP, VND) doesn't come out a hundredfold wrong.
  const inLeg = Number(minorInLeg) / minorUnits(leg);
  return Math.round((inLeg / rate) * minorUnits(to));
}

const csvEscape = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Leg › Category › Subcategory, skipping the levels a row doesn't have.
 *
 * A cash movement has no category by design, so it gets no path even if it can
 * be traced to a leg — filing a withdrawal under a category would make it look
 * like spend against that category's allocation, which is what it isn't.
 */
function categoryPath(e) {
  if (MOVEMENT.has(e.entry_type)) return "";
  return [e.leg_name, e.parent_name, e.category_name]
    .filter(Boolean)
    .filter((name, i, all) => all.indexOf(name) === i)   // a leg-level entry repeats itself
    .join(" › ");
}

/**
 * Build the CSV.
 *
 * @param {object} budget  the budgets row (name, base_currency)
 * @param {Array}  rows    entries joined to their leg: leg_name, leg_currency,
 *                         leg_rates, parent_name, category_name
 * @returns {string} CSV text
 */
export function buildExportCsv(budget, rows) {
  const base = (budget?.base_currency || "NZD").toUpperCase();
  const baseLower = base.toLowerCase();

  const head = [
    "date", "leg", "type", "instructor", "category", "category_path",
    "description", "method",
    "amount", "currency", "rate", "amount_in_leg_currency", "leg_currency",
    `leg_per_${baseLower}`, `${baseLower}_estimate`, `actual_${baseLower}`,
    baseLower, `${baseLower}_source`, "receipt",
  ];

  const lines = [head.join(",")];

  // Totals are accumulated in base minor units from the same figures that were
  // printed, so the bottom of the file always adds up to the rows above it.
  const legTotals = new Map();
  const catTotals = new Map();
  const methodTotals = new Map();
  let grand = 0;
  let estimated = 0;
  let unconvertible = 0;

  for (const e of rows) {
    const legCur = e.leg_currency || e.currency;
    const rates = e.leg_rates || {};
    const legPerBase = Number(rates[base]);
    const isMovement = MOVEMENT.has(e.entry_type);

    // A movement has no budget_amount worth converting — see the header.
    const estimate = isMovement
      ? null
      : toBaseMinor(e.budget_amount, legCur, rates, base);
    const actual = e.actual_base === null || e.actual_base === undefined
      ? null
      : Math.round(Number(e.actual_base));

    const value = actual !== null ? actual : estimate;
    const source = actual !== null ? "actual" : (estimate !== null ? "estimate" : "");

    if (value !== null) {
      grand += value;
      if (source === "estimate") estimated += value;
      const legKey = e.leg_name || "(no leg)";
      legTotals.set(legKey, (legTotals.get(legKey) || 0) + value);
      const catKey = categoryPath(e) || (isMovement ? "(cash movements)" : "(uncategorised)");
      catTotals.set(catKey, (catTotals.get(catKey) || 0) + value);
      const m = e.payment_method || "(none)";
      methodTotals.set(m, (methodTotals.get(m) || 0) + value);
    } else if (!isMovement) {
      unconvertible++;
    }

    lines.push([
      e.spent_on, e.leg_name || "", e.entry_type, e.email,
      e.category_name || "", categoryPath(e),
      e.description, e.payment_method,
      asDecimal(e.amount, e.currency), e.currency, Number(e.rate),
      asDecimal(e.budget_amount, legCur), legCur || "",
      Number.isFinite(legPerBase) && legPerBase > 0 ? legPerBase : "",
      estimate === null ? "" : asDecimal(estimate, base),
      actual === null ? "" : asDecimal(actual, base),
      value === null ? "" : asDecimal(value, base),
      source,
      e.receipt_link || "",
    ].map(csvEscape).join(","));
  }

  // ── totals ────────────────────────────────────────────────────────────────
  // Below a blank line and under their own header, so selecting the entry rows
  // and summing the `nzd` column can't accidentally include a subtotal.
  const pad = (cells) => {
    const row = cells.slice(0, head.length);
    while (row.length < head.length) row.push("");
    return row.map(csvEscape).join(",");
  };

  lines.push("");
  lines.push(pad([`TOTALS (${base})`]));
  lines.push(pad(["scope", "name", "entries", base.toLowerCase()]));

  const block = (scope, map) => {
    for (const [name, total] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
      const n = rows.filter((e) => matches(scope, e, name)).length;
      lines.push(pad([scope, name, n, asDecimal(total, base)]));
    }
  };
  const matches = (scope, e, name) => {
    if (scope === "leg") return (e.leg_name || "(no leg)") === name;
    if (scope === "method") return (e.payment_method || "(none)") === name;
    const isMovement = MOVEMENT.has(e.entry_type);
    return (categoryPath(e) || (isMovement ? "(cash movements)" : "(uncategorised)")) === name;
  };

  block("leg", legTotals);
  block("category", catTotals);
  block("method", methodTotals);
  lines.push(pad(["total", "", rows.length, asDecimal(grand, base)]));

  // What the reader needs to know before trusting that total.
  lines.push("");
  lines.push(pad([
    "note",
    `${asDecimal(estimated, base)} of the ${asDecimal(grand, base)} total is estimated at the leg's planning rate, not a settled ${base} figure.`,
  ]));
  if (unconvertible) {
    lines.push(pad([
      "note",
      `${unconvertible} row${unconvertible === 1 ? "" : "s"} could not be converted — the leg has no ${base} rate. They are excluded from every total above.`,
    ]));
  }

  return lines.join("\n");
}
