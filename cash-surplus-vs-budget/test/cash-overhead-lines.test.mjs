// Aggregating the P&L's expense lines across months.
//
// The arithmetic is trivial. What is not trivial is the denominator, and every
// test here is really about that: a line absent from a month means zero spent,
// not "no opinion", and averaging over only the months a line appeared in turns
// an annual insurance premium into a large standing cost.

import assert from "node:assert/strict";
import { overheadLines } from "../netlify/functions/_shared/cash-overhead-lines.mjs";

const month = (key, lines) => ({ month: key, lines });
const find = (r, name) => r.lines.find((l) => l.name === name);

/* ---- the denominator, which is the whole point ---- */
{
  // Rent every month at 5,000. Insurance once, at 12,000.
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `2026-${String(i + 1).padStart(2, "0")}`;
    const lines = [{ name: "Rent", amount: 5_000, nonCash: false }];
    if (i === 5) lines.push({ name: "Insurance", amount: 12_000, nonCash: false });
    return month(key, lines);
  });

  const r = overheadLines(months);

  const rent = find(r, "Rent");
  const ins = find(r, "Insurance");

  assert.equal(rent.annualised, 60_000, "rent is 5,000 x 12");
  // THE BUG THIS EXISTS TO PREVENT. Insurance appeared in ONE month. Dividing
  // 12,000 by 1 and multiplying by 12 gives 144,000 — a number twelve times
  // the truth, presented as an annual cost, ranked above the rent, and
  // completely plausible on screen.
  assert.equal(ins.annualised, 12_000,
    "an annual premium is 12,000 a year, not 12,000 x 12");
  assert.equal(ins.monthlyMean, 1_000, "its monthly run rate is 1,000");
  assert.equal(ins.monthsWithSpend, 1, "even though it landed once");

  // And rent must outrank insurance, because it does.
  assert.equal(r.lines[0].name, "Rent", "ranked by what it actually costs a year");
  console.log("✓ a line absent from a month counts as zero, not as missing");
}

/* ---- steady vs lumpy ---- */
{
  const months = Array.from({ length: 12 }, (_, i) => month(`2026-${String(i + 1).padStart(2, "0")}`, [
    { name: "Salaries", amount: 40_000, nonCash: false },
    { name: "Travel", amount: i === 2 ? 24_000 : 0, nonCash: false },
    { name: "Software", amount: 1_800 + (i % 2 ? 100 : -100), nonCash: false },
  ]));

  const r = overheadLines(months);

  assert.equal(find(r, "Salaries").steady, true, "the same number every month is steady");
  assert.equal(find(r, "Software").steady, true, "and so is one that wobbles slightly");
  assert.equal(find(r, "Travel").steady, false, "one month out of twelve is not steady");
  assert.ok(find(r, "Travel").spread > 10, "spread says how far from a run rate it is");

  // The split is what decides how you go about cutting it, so it has to be
  // right at the total level too, not just per line.
  assert.equal(r.steadyTotal, find(r, "Salaries").total + find(r, "Software").total);
  assert.equal(r.lumpyTotal, find(r, "Travel").total);
  console.log("✓ steady and lumpy are separated, and the totals agree");
}

/* ---- non-cash lines ---- */
{
  const months = [
    month("2026-04", [
      { name: "Rent", amount: 5_000, nonCash: false },
      { name: "Bank Revaluations", amount: 33_805, nonCash: true },
    ]),
    month("2026-05", [
      { name: "Rent", amount: 5_000, nonCash: false },
      { name: "Bank Revaluations", amount: -28_000, nonCash: true },
    ]),
  ];

  const cash = overheadLines(months, { basis: "cash" });
  assert.equal(cash.lines.length, 1, "revaluations are not spending");
  assert.equal(cash.total, 10_000);

  const total = overheadLines(months, { basis: "total" });
  assert.equal(total.lines.length, 2, "and are still available when asked for");
  assert.equal(find(total, "Bank Revaluations").nonCash, true, "labelled, so nobody cuts it");
  console.log("✓ non-cash lines are excluded from the cash view and labelled in the other");
}

/* ---- a record stored before every line was kept ---- */
{
  // Version 4 and earlier stored the twelve biggest lines only. Their absent
  // lines are genuinely UNKNOWN, not zero — treating them as zero would drag
  // every small line's average down by however many old months are in the mix,
  // silently. So it is reported instead.
  const months = [
    { month: "2026-04", topLines: [{ name: "Rent", amount: 5_000 }] },
    month("2026-05", [
      { name: "Rent", amount: 5_000, nonCash: false },
      { name: "Coffee", amount: 200, nonCash: false },
    ]),
  ];

  const r = overheadLines(months);
  assert.deepEqual(r.truncatedMonths, ["2026-04"],
    "the page must be able to say which months are only partly known");
  assert.equal(r.monthsObserved, 2, "both months still count toward the denominator");
  assert.equal(find(r, "Rent").total, 10_000, "a top-twelve line is complete either way");
  console.log("✓ truncated months are named rather than quietly averaged in");
}

/* ---- the same account name appearing twice in one month ---- */
{
  // A P&L walk collects leaves, and a chart of accounts can carry the same
  // account name under two parents. Assigning rather than adding would keep
  // whichever came last and lose the other.
  const r = overheadLines([
    month("2026-04", [
      { name: "Subscriptions", amount: 300, nonCash: false },
      { name: "Subscriptions", amount: 700, nonCash: false },
    ]),
  ]);
  assert.equal(find(r, "Subscriptions").total, 1_000, "both leaves count");
  console.log("✓ a repeated account name sums rather than overwrites");
}

/* ---- concentration ---- */
{
  const months = [month("2026-04", [
    { name: "Salaries", amount: 70_000, nonCash: false },
    { name: "Rent", amount: 15_000, nonCash: false },
    { name: "Software", amount: 8_000, nonCash: false },
    { name: "Stationery", amount: 500, nonCash: false },
    { name: "Coffee", amount: 300, nonCash: false },
  ])];

  const r = overheadLines(months);
  assert.equal(r.concentration.lines, 2,
    "salaries plus rent is already 90% — that is the conversation, not the coffee");
  assert.ok(r.concentration.sharePct >= 80);
  assert.deepEqual(r.concentration.names, ["Salaries", "Rent"]);
  console.log("✓ concentration names the handful of lines that matter");
}

/* ---- degenerate inputs must not throw ---- */
{
  assert.equal(overheadLines([]).monthsObserved, 0);
  assert.equal(overheadLines([]).annualised, 0, "no months means no run rate, not NaN");
  assert.equal(overheadLines([month("2026-04", [])]).lines.length, 0);
  assert.equal(overheadLines([month("2026-04", [{ name: "  ", amount: 5 }])]).lines.length, 0,
    "a nameless line is dropped rather than filed under empty string");
  const r = overheadLines([month("2026-04", [{ name: "Odd", amount: "not a number" }])]);
  assert.equal(find(r, "Odd").total, 0, "an unparseable amount is zero, not NaN");
  console.log("✓ empty and malformed input degrade quietly");
}

console.log("\nAll overhead-line tests passed.");
