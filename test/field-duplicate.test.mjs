// test/field-duplicate.test.mjs
//
// Copying a budget's category tree. Run: npm run test:duplicate
//
// The failure that matters: a subcategory whose parent_id still points at the
// ORIGINAL budget's row. The database accepts it — the id exists — and the copy
// then quietly reports part of its spend into last season's programme.

import assert from "node:assert/strict";
import { planCategoryCopy } from "../netlify/functions/_shared/field-duplicate.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let n = 0;
const ids = () => `new${++n}`;
const reset = () => { n = 0; };

const TREE = [
  // Deliberately shuffled: the caller's ordering must not matter.
  { id: "sub1", budget_id: "old", name: "Groceries", parent_id: "cat1", allocated: 800000, sort_order: 1 },
  { id: "leg1", budget_id: "old", name: "Peru", parent_id: null, allocated: 0, sort_order: 1, currency: "PEN", rates: { NZD: 2.1 } },
  { id: "cat2", budget_id: "old", name: "Transport", parent_id: "leg1", allocated: 14000, sort_order: 2 },
  { id: "cat1", budget_id: "old", name: "Food", parent_id: "leg1", allocated: 0, sort_order: 1 },
  { id: "sub2", budget_id: "old", name: "Restaurants", parent_id: "cat1", allocated: 200000, sort_order: 2 },
];

test("every category is copied, once", () => {
  reset();
  const plan = planCategoryCopy(TREE, "new", ids);
  assert.equal(plan.length, TREE.length);
  assert.equal(new Set(plan.map((c) => c.id)).size, TREE.length, "fresh ids, all distinct");
});

test("parents come before their children", () => {
  reset();
  const plan = planCategoryCopy(TREE, "new", ids);
  const seen = new Set();
  for (const c of plan) {
    if (c.parent_id) assert.ok(seen.has(c.parent_id), `${c.name} inserted before its parent`);
    seen.add(c.id);
  }
});

test("a child points at the COPY's parent, never the original's", () => {
  reset();
  const plan = planCategoryCopy(TREE, "new", ids);
  const oldIds = new Set(TREE.map((c) => c.id));
  for (const c of plan) {
    assert.equal(c.budget_id, "new");
    if (c.parent_id) {
      assert.ok(!oldIds.has(c.parent_id), `${c.name} still points at a source row`);
      assert.ok(plan.some((x) => x.id === c.parent_id), `${c.name}'s parent isn't in the copy`);
    }
  }
});

test("the shape survives: same names under the same parents", () => {
  reset();
  const plan = planCategoryCopy(TREE, "new", ids);
  const nameOf = new Map(plan.map((c) => [c.id, c.name]));
  const shape = plan
    .map((c) => `${c.parent_id ? nameOf.get(c.parent_id) + " > " : ""}${c.name}`)
    .sort();
  assert.deepEqual(shape, [
    "Food > Groceries", "Food > Restaurants", "Peru", "Peru > Food", "Peru > Transport",
  ]);
});

test("allocations and sort order come across untouched", () => {
  reset();
  const plan = planCategoryCopy(TREE, "new", ids);
  const byName = Object.fromEntries(plan.map((c) => [c.name, c]));
  assert.equal(byName.Groceries.allocated, 800000);
  assert.equal(byName.Restaurants.allocated, 200000);
  assert.equal(byName.Transport.sort_order, 2);
});

test("the leg keeps its currency and planning rates", () => {
  // They are a decision someone made. Repricing a copy at today's rate is the
  // card's job to suggest, not this one's to do.
  reset();
  const leg = planCategoryCopy(TREE, "new", ids).find((c) => c.name === "Peru");
  assert.equal(leg.currency, "PEN");
  assert.deepEqual(leg.rates, { NZD: 2.1 });
});

test("currency and rates are stripped below the leg", () => {
  // The database trigger nulls them anyway; carrying them would be a second
  // source of truth that happens to agree today.
  reset();
  const plan = planCategoryCopy(
    [...TREE, { id: "bad", name: "Odd", parent_id: "leg1", currency: "USD", rates: { NZD: 9 }, allocated: 0, sort_order: 9 }],
    "new", ids);
  const odd = plan.find((c) => c.name === "Odd");
  assert.equal(odd.currency, null);
  assert.deepEqual(odd.rates, {});
});

test("a dangling parent is refused rather than quietly dropped", () => {
  reset();
  assert.throws(
    () => planCategoryCopy([{ id: "x", name: "Orphan", parent_id: "gone", allocated: 0, sort_order: 1 }], "new", ids),
    /not part of this budget/);
});

test("a cycle is caught instead of recursing forever", () => {
  reset();
  assert.throws(() => planCategoryCopy([
    { id: "a", name: "A", parent_id: "b", allocated: 0, sort_order: 1 },
    { id: "b", name: "B", parent_id: "a", allocated: 0, sort_order: 1 },
  ], "new", ids), /own ancestor/);
});

test("an empty budget copies to an empty tree", () => {
  reset();
  assert.deepEqual(planCategoryCopy([], "new", ids), []);
  assert.deepEqual(planCategoryCopy(null, "new", ids), []);
});

test("missing allocations and sort orders default rather than becoming null", () => {
  reset();
  const [c] = planCategoryCopy([{ id: "l", name: "Leg", parent_id: null }], "new", ids);
  assert.equal(c.allocated, 0);
  assert.equal(c.sort_order, 0);
  assert.deepEqual(c.rates, {});
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
