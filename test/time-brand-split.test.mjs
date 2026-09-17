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

const e = (o) => ({ ended_at: '2026-09-15T10:00:00Z', locked: false, minutes: 60, ...o });

// 1. brandOf falls back to one visible bucket
assert.equal(ctx.brandOf(e({ project_brand: 'Pacific Discovery' })), 'Pacific Discovery');
assert.equal(ctx.brandOf(e({ project_brand: null })), 'Unassigned');   // no project at all
assert.equal(ctx.brandOf(e({ project_brand: '   ' })), 'Unassigned');  // project, brand never set

// 2. subtotals are exact and the split accounts for every finished minute
const rows = [
  e({ project_brand: 'Pacific Discovery', minutes: 97 }),
  e({ project_brand: 'Pacific Discovery', minutes: 38, locked: true }),
  e({ project_brand: 'Unearthed Education', minutes: 143 }),
  e({ project_brand: null, minutes: 22 }),
  e({ project_brand: 'EDA Group', minutes: 61 }),
  e({ project_brand: 'Pacific Discovery', minutes: 55, ended_at: null }), // running — excluded
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
const retired = ctx.brandSplit([e({ project_brand: 'Old Brand Ltd', minutes: 30 })]);
assert.deepEqual(retired.map((b) => b.brand), ['Old Brand Ltd']);

// 5. chips: escaped, labelled, and the approval state called out
const chips = ctx.brandChips(split, 'by brand');
assert.match(chips, /Pacific Discovery <b>2\.25 h<\/b> <em>1\.62 to approve<\/em>/);
assert.match(chips, /class="bchip b-none"[\s\S]*?Unassigned/);
assert.match(chips, /EDA Group <b>1\.02 h<\/b>(?! <em>)/, 'nothing approved yet ⇒ no "to approve" tail');
const allLocked = ctx.brandSplit([e({ project_brand: 'Conference', minutes: 45, locked: true })]);
assert.match(ctx.brandChips(allLocked), /🔒 approved/);
assert.match(ctx.brandChips(ctx.brandSplit([e({ project_brand: '<img src=x>' })])), /&lt;img src=x&gt;/);
assert.equal(ctx.brandChips([]), '', 'no finished entries ⇒ no breakdown row');

console.log('brand split: all checks passed');
