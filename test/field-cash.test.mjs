// test/field-cash.test.mjs
//
// Cash on hand. Run: npm run test:cash
//
// The arithmetic is small but the failure mode isn't: a wrong sign here reads
// as a plausible number rather than an obvious error, and the figure it feeds
// is the one someone counts a pocket against.

import assert from "node:assert/strict";
import { foldCash, cashByCurrency, CASH_MOVEMENT_TYPES } from "../netlify/functions/_shared/field-cash.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Rows arrive pre-grouped by (budget, person, currency, resolved type, method).
const row = (o) => ({ budget_id: "b1", email: "katie@pd.org", currency: "PEN", n: 1, ...o });

const held = (result, email, currency, scope = "byBudget") => {
  const r = result[scope].find((x) => x.email === email && x.currency === currency);
  return r ? r.held : null;
};

test("a withdrawal puts cash in the pocket", () => {
  const r = foldCash([row({ kind: "withdrawal", method: "cash", total: 200000 })]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 200000);
  assert.equal(r.byBudget[0].in, 200000);
  assert.equal(r.byBudget[0].out, 0);
  assert.equal(r.byBudget[0].spent, 0);
});

test("a cash expense takes it out again", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "expense", method: "cash", total: 45000 }),
  ]);
  assert.equal(r.byBudget[0].in, 200000);
  assert.equal(r.byBudget[0].spent, 45000);
  assert.equal(held(r, "katie@pd.org", "PEN"), 155000);
});

test("a card expense never touches the float", () => {
  // The whole point of the payment_method column. A card charge is real spend
  // against the budget but the notes in the pocket are untouched.
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "expense", method: "card", total: 90000 }),
  ]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 200000);
  assert.equal(r.byBudget[0].spent, 0);
});

test("an exchange moves cash between currencies without creating any", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "exchange", method: "cash", total: -100000 }),          // PEN given
    row({ kind: "exchange", method: "cash", total: 30000, currency: "USD" }), // USD received
  ]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 100000);
  assert.equal(held(r, "katie@pd.org", "USD"), 30000);
});

test("money exchanged out is reported as out, not netted off what came in", () => {
  // The balance is the same either way; the components are not. "In 1,000"
  // for someone who withdrew 2,000 matches no receipt and no memory.
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "exchange", method: "cash", total: -100000 }),
  ]);
  const pen = r.byBudget[0];
  assert.equal(pen.in, 200000, "the withdrawal stands on its own");
  assert.equal(pen.out, 100000, "and is reported as a magnitude, not a negative");
  assert.equal(pen.held, 100000);
});

test("currencies are never added together", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "withdrawal", method: "cash", total: 30000, currency: "USD" }),
  ]);
  assert.equal(r.byBudget.length, 2);
  assert.deepEqual(r.byBudget.map((x) => x.currency).sort(), ["PEN", "USD"]);
});

test("a transfer out reduces the giver and raises the receiver", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "transfer", method: "cash", total: -50000 }),
    row({ kind: "transfer", method: "cash", total: 50000, email: "manuel@pd.org" }),
  ]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 150000);
  assert.equal(held(r, "manuel@pd.org", "PEN"), 50000);
});

// ── corrections ─────────────────────────────────────────────────────────────
// The caller resolves corrects_id and passes the ORIGINAL's type and method,
// with the correction's already-negated amount.

test("correcting a cash expense gives the cash back", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "expense", method: "cash", total: 45000 }),
    row({ kind: "expense", method: "cash", total: -45000 }),   // the correction
  ]);
  assert.equal(r.byBudget[0].spent, 0);
  assert.equal(held(r, "katie@pd.org", "PEN"), 200000);
});

test("correcting a withdrawal takes it back off the float", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "withdrawal", method: "cash", total: -200000 }),
  ]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 0);
  assert.equal(r.byBudget[0].in, 200000, "the withdrawal still happened");
  assert.equal(r.byBudget[0].out, 200000, "and undoing it reads as cash leaving");
});

test("a correction with no matching original is counted, not guessed at", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "correction", method: "cash", total: -45000, n: 2 }),
  ]);
  assert.equal(r.unresolved, 2);
  assert.equal(held(r, "katie@pd.org", "PEN"), 200000, "an unmatched correction must not silently move the float");
});

// ── shape ───────────────────────────────────────────────────────────────────

test("a person's total spans budgets while each budget keeps its own", () => {
  const r = foldCash([
    row({ budget_id: "peru", kind: "withdrawal", method: "cash", total: 200000 }),
    row({ budget_id: "peru", kind: "expense", method: "cash", total: 50000 }),
    row({ budget_id: "ecuador", kind: "withdrawal", method: "cash", total: 80000 }),
  ]);
  const peru = r.byBudget.find((x) => x.budget_id === "peru");
  const ecuador = r.byBudget.find((x) => x.budget_id === "ecuador");
  assert.equal(peru.held, 150000);
  assert.equal(ecuador.held, 80000);
  assert.equal(held(r, "katie@pd.org", "PEN", "byPerson"), 230000, "the pocket is one pocket");
});

test("a negative balance is reported, not clamped", () => {
  // More cash spent than was ever recorded as drawn. That's a missing
  // withdrawal, and hiding it behind a zero would hide the thing worth seeing.
  const r = foldCash([row({ kind: "expense", method: "cash", total: 45000 })]);
  assert.equal(held(r, "katie@pd.org", "PEN"), -45000);
});

test("rows without an email or currency are skipped rather than bucketed under blank", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 100, email: null }),
    row({ kind: "withdrawal", method: "cash", total: 100, currency: null }),
  ]);
  assert.deepEqual(r.byBudget, []);
});

test("bigint strings from Postgres are coerced", () => {
  // The driver returns bigint as a string; "200000" - "45000" would be NaN.
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: "200000" }),
    row({ kind: "expense", method: "cash", total: "45000" }),
  ]);
  assert.equal(held(r, "katie@pd.org", "PEN"), 155000);
});

test("empty and missing input are both fine", () => {
  for (const input of [[], null, undefined]) {
    const r = foldCash(input);
    assert.deepEqual(r.byBudget, []);
    assert.deepEqual(r.byPerson, []);
    assert.equal(r.unresolved, 0);
  }
});

test("cashByCurrency totals a budget without mixing currencies", () => {
  const r = foldCash([
    row({ kind: "withdrawal", method: "cash", total: 200000 }),
    row({ kind: "expense", method: "cash", total: 45000 }),
    row({ kind: "withdrawal", method: "cash", total: 150000, email: "manuel@pd.org" }),
    row({ kind: "withdrawal", method: "cash", total: 30000, currency: "USD" }),
    row({ budget_id: "other", kind: "withdrawal", method: "cash", total: 999999 }),
  ]);
  const totals = cashByCurrency(r.byBudget, "b1");
  const pen = totals.find((t) => t.currency === "PEN");
  const usd = totals.find((t) => t.currency === "USD");
  assert.equal(pen.in, 350000);
  assert.equal(pen.spent, 45000);
  assert.equal(pen.held, 305000);
  assert.equal(pen.people, 2);
  assert.equal(usd.held, 30000);
  assert.equal(totals.length, 2, "the other budget must not leak in");
});

test("the movement types are exactly the ones the schema names", () => {
  assert.deepEqual([...CASH_MOVEMENT_TYPES].sort(), ["exchange", "transfer", "withdrawal"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
