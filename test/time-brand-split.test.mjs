// Pulls brandOf / brandSplit / brandChips straight out of the page and checks
// the arithmetic, the ordering, and that unbranded time is never dropped.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../time-tracking/index.html', import.meta.url), 'utf8');
const src  = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const grab = (name, kind = 'function') => {
  const start = src.indexOf(`${kind} ${name}`);
  assert.ok(start > -1, `${name} not found in the page`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
};

const ctx = new Function(`
  ${src.match(/var BRAND_META = \{[\s\S]*?\};/)[0]}
  ${src.match(/var NO_BRAND = .*?;/)[0]}
  ${grab('esc')} ${grab('hours')} ${grab('brandOf')} ${grab('brandSplit')} ${grab('brandChips')}
  return { brandOf, brandSplit, brandChips, NO_BRAND };
`)();

// `brand` is the field the server resolves and the UI totals against; the tests
// below feed it directly because the entry-vs-project precedence is settled in
// SQL and covered in test/time-brand-approvals.db.test.mjs.
const e = (o) => ({ ended_at: '2026-09-15T10:00:00Z', locked: false, minutes: 60, ...o });

// 1. brandOf falls back to one visible bucket
assert.equal(ctx.brandOf(e({ brand: 'Pacific Discovery' })), 'Pacific Discovery');
assert.equal(ctx.brandOf(e({ brand: null })), 'Unassigned');   // no project at all
assert.equal(ctx.brandOf(e({ brand: '   ' })), 'Unassigned');  // project, brand never set

// 2. subtotals are exact and the split accounts for every finished minute
const rows = [
  e({ brand: 'Pacific Discovery', minutes: 97 }),
  e({ brand: 'Pacific Discovery', minutes: 38, locked: true }),
  e({ brand: 'Unearthed Education', minutes: 143 }),
  e({ brand: null, minutes: 22 }),
  e({ brand: 'EDA Group', minutes: 61 }),
  e({ brand: 'Pacific Discovery', minutes: 55, ended_at: null }), // running — excluded
];
const split = ctx.brandSplit(rows);
const finished = rows.filter((r) => r.ended_at).reduce((s, r) => s + r.minutes, 0);
assert.equal(split.reduce((s, b) => s + b.minutes, 0), finished, 'brand subtotals must sum to the exact finished total');
assert.equal(split.reduce((s, b) => s + b.openMinutes, 0),
  rows.filter((r) => r.ended_at && !r.locked).reduce((s, r) => s + r.minutes, 0), 'open minutes must exclude locked entries');

const pd = split.find((b) => b.brand === 'Pacific Discovery');
assert.equal(pd.minutes, 135);      // 97 + 38, running entry not counted
assert.equal(pd.openMinutes, 97);   // the locked 38 is already approved
assert.equal(pd.entries, 2);

// 3. declared-brand order first, Unassigned last
assert.deepEqual(split.map((b) => b.brand),
  ['EDA Group', 'Unearthed Education', 'Pacific Discovery', 'Unassigned']);

// 4. a retired brand still shows up rather than vanishing
const retired = ctx.brandSplit([e({ brand: 'Old Brand Ltd', minutes: 30 })]);
assert.deepEqual(retired.map((b) => b.brand), ['Old Brand Ltd']);

// 5. chips: escaped, labelled, and the approval state called out
const chips = ctx.brandChips(split, 'by brand');
assert.match(chips, /Pacific Discovery <b>2\.25 h<\/b> <em>1\.62 to approve<\/em>/);
assert.match(chips, /class="bchip b-none"[\s\S]*?Unassigned/);
assert.match(chips, /EDA Group <b>1\.02 h<\/b>(?! <em>)/, 'nothing approved yet ⇒ no "to approve" tail');
const allLocked = ctx.brandSplit([e({ brand: 'Conference', minutes: 45, locked: true })]);
assert.match(ctx.brandChips(allLocked), /🔒 approved/);
assert.match(ctx.brandChips(ctx.brandSplit([e({ brand: '<img src=x>' })])), /&lt;img src=x&gt;/);
assert.equal(ctx.brandChips([]), '', 'no finished entries ⇒ no breakdown row');

console.log('brand split: all checks passed');

/* ------------------------------------------------ payout allocation */
const alloc = new Function(`
  ${src.match(/var BRAND_META = \{[\s\S]*?\};/)[0]}
  ${src.match(/var NO_BRAND = .*?;/)[0]}
  ${grab('allocateByBrand')}
  return allocateByBrand;
`)();

const cents = (parts) => parts.reduce((s, p) => s + Math.round(p.amount * 100), 0);

// 6. the parts come back to the whole, including the awkward thirds
for (const [mins, amount] of [
  [[10, 10, 10], 100],            // 3 × 33.333… — the classic leftover cent
  [[1, 1, 1, 1, 1, 1, 1], 945.63],
  [[1335, 210], 945.63],          // a real-shaped week
  [[7], 0.01],                    // one brand, one cent
  [[1, 99999], 1009.38],
]) {
  const parts = alloc(mins.map((m, i) => ({ brand: `B${i}`, minutes: m })), amount);
  assert.equal(cents(parts), Math.round(amount * 100),
    `allocation of ${amount} across ${mins.join('/')} must reconcile to the cent`);
  assert.ok(parts.every((p) => p.amount >= 0), 'no negative shares');
}

// 7. a bigger share never gets less money than a smaller one
const ordered = alloc([
  { brand: 'Pacific Discovery', minutes: 1335 },
  { brand: 'Unearthed Education', minutes: 210 },
  { brand: 'EDA Group', minutes: 97 },
], 945.63);
for (let i = 1; i < ordered.length; i++) {
  assert.ok(ordered[i - 1].amount >= ordered[i].amount, 'more hours must never allocate less money');
}

// 8. no rate yet ⇒ hours still split, money stays absent rather than showing 0.00
const noRate = alloc([{ brand: 'Conference', minutes: 90 }], null);
assert.equal(noRate[0].minutes, 90);
assert.equal(noRate[0].amount, undefined, 'an unrated timesheet must not invent a payout');

// 9. the server's empty-string bucket becomes the labelled one
assert.equal(alloc([{ brand: '', minutes: 30 }], 10)[0].brand, 'Unassigned');
assert.deepEqual(alloc([], 10), []);
assert.deepEqual(alloc(null, 10), []);

console.log('payout allocation: all checks passed');
