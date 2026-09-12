// test/cash-budget.test.mjs
//
// Overheads from Xero's Budget Manager.
//
// The behaviour that matters most is what gets LEFT OUT. A budget spans every
// account; pulling direct costs into the overheads row would double-count them
// against Program costs, and pulling revenue in would make overheads negative.
// Both mistakes produce a plausible-looking table.
//
// Run: node test/cash-budget.test.mjs

import assert from "node:assert/strict";
import {
  overheadsFromBudget,
  classifyLine,
  periodToSlot,
} from "../netlify/functions/_shared/cash-budget.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const acc = (id, code, name, type, klass) => [id, { code, name, type, klass }];
const ACCOUNTS = new Map([
  acc("a1", "477", "Wages", "OVERHEADS", "EXPENSE"),
  acc("a2", "469", "Rent", "OVERHEADS", "EXPENSE"),
  acc("a3", "404", "Bank Fees", "EXPENSE", "EXPENSE"),
  acc("a4", "310", "Cost of programs", "DIRECTCOSTS", "EXPENSE"),
  acc("a5", "200", "Sales Income", "REVENUE", "REVENUE"),
  acc("a6", "498", "Bank Revaluations", "OVERHEADS", "EXPENSE"),
  acc("a7", "710", "Office Equipment", "FIXED", "ASSET"),
]);

const line = (accountId, balances) => ({
  AccountID: accountId,
  BudgetBalances: Object.entries(balances).map(([Period, Amount]) => ({ Period, Amount })),
});

/* ---------- period mapping ---------- */

{
  assert.equal(periodToSlot("2026-04-30", 2026), 0, "April is slot 0");
  assert.equal(periodToSlot("2026-12-31", 2026), 8, "December is slot 8");
  assert.equal(periodToSlot("2027-03-31", 2026), 11, "March is the last slot");
  assert.equal(periodToSlot("2027-04-30", 2026), null, "the next April is outside the year");
  assert.equal(periodToSlot("2026-03-31", 2026), null, "and so is the previous March");
  assert.equal(periodToSlot("2026-04", 2026), 0, "a period without a day still maps");
  assert.equal(periodToSlot("nonsense", 2026), null, "and junk maps to nothing");
  console.log("✓ budget periods map to fiscal slots, April first");
}

/* ---------- THE ONE THAT MATTERS: what gets excluded ---------- */

{
  assert.equal(classifyLine(ACCOUNTS.get("a1")).include, true, "wages are overheads");
  assert.equal(classifyLine(ACCOUNTS.get("a3")).include, true, "bank fees are real cash overheads");

  const direct = classifyLine(ACCOUNTS.get("a4"));
  assert.equal(direct.include, false, "direct costs must NOT land in overheads");
  assert.match(direct.reason, /already modelled as program costs/,
    "and the reason must say why, or the gap is unexplainable");

  const revenue = classifyLine(ACCOUNTS.get("a5"));
  assert.equal(revenue.include, false, "revenue is not an overhead");

  const asset = classifyLine(ACCOUNTS.get("a7"));
  assert.equal(asset.include, false, "an asset account is not an overhead");

  const nonCash = classifyLine(ACCOUNTS.get("a6"));
  assert.equal(nonCash.include, false, "revaluations are not cash");

  const unknown = classifyLine(null);
  assert.equal(unknown.include, false, "an account not in the chart is excluded, not assumed");
  assert.match(unknown.reason, /not in the chart of accounts/);
  console.log("✓ direct costs, revenue, assets and non-cash lines are all excluded");
}

/* ---------- a whole budget ---------- */

{
  const budget = {
    BudgetLines: [
      line("a1", { "2026-04-30": 20_000, "2026-05-31": 20_000, "2027-03-31": 21_000 }),
      line("a2", { "2026-04-30": 3_200, "2026-05-31": 3_200 }),
      line("a4", { "2026-04-30": 500_000 }),        // direct cost — must not count
      line("a5", { "2026-04-30": -1_000_000 }),     // revenue — must not count
      line("a6", { "2026-04-30": 75 }),             // non-cash — must not count
    ],
  };

  const r = overheadsFromBudget(budget, ACCOUNTS, 2026);

  near(r.months[0], 23_200, 0.01, "April is wages plus rent and nothing else");
  near(r.months[1], 23_200, 0.01, "and so is May");
  near(r.months[11], 21_000, 0.01, "March picks up the wages line");
  near(r.months[2], 0, 0.01, "a month the budget does not reach stays zero");
  near(r.months.reduce((s, n) => s + n, 0), 67_400, 0.01, "the year totals only the included lines");
  console.log("✓ only expense lines reach the overheads row");

  // Every exclusion is reported WITH its amount, so a missing 500k is visible
  // rather than being a hole someone has to go looking for.
  const excludedNames = r.excluded.map((e) => e.account);
  assert.ok(excludedNames.some((n) => n.includes("Cost of programs")));
  assert.ok(excludedNames.some((n) => n.includes("Sales Income")));
  const direct = r.excluded.find((e) => e.account.includes("Cost of programs"));
  near(direct.amount, 500_000, 0.01, "and the excluded amount is shown, not just the name");
  console.log("✓ exclusions are reported with their amounts");

  // Coverage: a budget that only reaches three months must say so, or eight
  // convincing zeros look like eight months of no overheads.
  assert.deepEqual(r.slotsCovered, [0, 1, 11], "only the months with real figures count as covered");
  console.log("✓ partial coverage is reported rather than shown as zeros");
}

/* ---------- degenerate input ---------- */

{
  const empty = overheadsFromBudget(null, ACCOUNTS, 2026);
  assert.equal(empty.months.length, 12, "always twelve months");
  assert.deepEqual(empty.slotsCovered, [], "and none of them covered");

  const noAccounts = overheadsFromBudget(
    { BudgetLines: [line("a1", { "2026-04-30": 20_000 })] }, new Map(), 2026);
  near(noAccounts.months[0], 0, 0.01,
    "with no chart of accounts nothing is included — better zero than miscategorised");
  assert.equal(noAccounts.excluded.length, 1, "and the line is reported as excluded");
  console.log("✓ a missing chart of accounts excludes rather than guesses");
}

console.log("\nAll budget tests passed.");
