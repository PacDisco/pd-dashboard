// Does refreshOpex reach back far enough for a COMPLETE fiscal year to exist?
//
// It used to walk fiscalMonthKeys(fy) alone, so the only year it could ever
// store was the one still running. monthlyCostProfile only accepts complete
// years, so the calendar profile was unreachable by construction — and the
// panel's "no complete fiscal year" gave no hint that waiting would never help.
import assert from "node:assert/strict";
import { fiscalMonthKeys } from "../netlify/functions/_shared/cash-xero.mjs";

const fy = 2026;
const years = 2;
const finished = [];
for (let back = 0; back < Math.max(1, years); back++) {
  const y = fy - back;
  finished.push(...(back === 0
    ? fiscalMonthKeys(y).slice(0, -1)
    : fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`))));
}

const prior = finished.filter((k) => k >= "2025-04" && k <= "2026-03");
assert.equal(prior.length, 12,
  "the prior fiscal year must arrive whole, or no profile can ever be derived");

// The running month stays out: its P&L is partial and would read as a genuine
// low month rather than an incomplete one.
assert.ok(!finished.includes(fiscalMonthKeys(fy).slice(-1)[0]),
  "the current month is still running and must not be stored as finished");

console.log(`✓ refreshOpex span covers ${finished.length} months, prior year whole`);
