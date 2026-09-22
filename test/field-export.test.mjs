// test/field-export.test.mjs
//
// The reconciliation CSV. Run: npm run test:export
//
// The figure that matters here is the one someone pastes into a reconciliation
// and reports on. Two ways to get it wrong quietly: converting at the wrong
// rate, and letting an estimate pass for a settled number.

import assert from "node:assert/strict";
import { buildExportCsv, toBaseMinor, asDecimal } from "../netlify/functions/_shared/field-export.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const BUDGET = { name: "Peru — Feb 2026", base_currency: "NZD" };
// PEN 2.10 per NZD 1, USD 3.34 per… (leg units per 1 unit of the other)
const RATES = { NZD: 2.1, USD: 3.34 };

const entry = (o) => ({
  spent_on: "2026-02-10", leg_name: "Peru", entry_type: "expense",
  email: "katie@pd.org", category_name: "Food", parent_name: null,
  description: "Market", payment_method: "cash",
  amount: 21000, currency: "PEN", rate: 1,
  budget_amount: 21000, leg_currency: "PEN", leg_rates: RATES,
  actual_base: null, receipt_link: null, ...o,
});

const parse = (csv) => csv.split("\n").map((l) => {
  // Good enough for these fixtures: no embedded newlines.
  const out = []; let cur = ""; let quoted = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (quoted) {
      if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
});
const cols = (csv) => {
  const head = parse(csv)[0];
  return (row, name) => row[head.indexOf(name)];
};

// ── conversion ──────────────────────────────────────────────────────────────

test("a leg amount converts into the base at the leg's rate", () => {
  // PEN 210.00 at 2.10 PEN per NZD = NZD 100.00
  assert.equal(toBaseMinor(21000, "PEN", RATES, "NZD"), 10000);
});

test("a leg already in the base currency passes straight through", () => {
  assert.equal(toBaseMinor(12345, "NZD", {}, "NZD"), 12345);
});

test("a zero-decimal leg currency doesn't come out a hundredfold wrong", () => {
  // CLP has no minor units: 100000 minor IS CLP 100,000. At 350 per NZD that's
  // NZD 285.71 → 28571 minor. Treating it as "cents" would give NZD 2.86.
  assert.equal(toBaseMinor(100000, "CLP", { NZD: 350 }, "NZD"), 28571);
});

test("no rate, a junk rate or no currency gives null rather than zero", () => {
  // Zero would sum silently into a total and understate it.
  assert.equal(toBaseMinor(21000, "PEN", {}, "NZD"), null);
  assert.equal(toBaseMinor(21000, "PEN", { NZD: 0 }, "NZD"), null);
  assert.equal(toBaseMinor(21000, "PEN", { NZD: -2 }, "NZD"), null);
  assert.equal(toBaseMinor(21000, "PEN", { NZD: "abc" }, "NZD"), null);
  assert.equal(toBaseMinor(21000, "", RATES, "NZD"), null);
});

// ── per-line columns ────────────────────────────────────────────────────────

test("every line carries its own base-currency figure", () => {
  const csv = buildExportCsv(BUDGET, [entry()]);
  const at = cols(csv);
  const row = parse(csv)[1];
  assert.equal(at(row, "amount_in_leg_currency"), "210.00");
  assert.equal(at(row, "leg_currency"), "PEN");
  assert.equal(at(row, "leg_per_nzd"), "2.1");
  assert.equal(at(row, "nzd_estimate"), "100.00");
  assert.equal(at(row, "nzd"), "100.00");
  assert.equal(at(row, "nzd_source"), "estimate");
});

test("a settled figure wins over the estimate, and says so", () => {
  // This is the whole point of keeping two columns: the bank's rate on the day
  // is not the planning rate typed in weeks earlier.
  const csv = buildExportCsv(BUDGET, [entry({ actual_base: 9750 })]);
  const at = cols(csv);
  const row = parse(csv)[1];
  assert.equal(at(row, "nzd_estimate"), "100.00", "the estimate is still shown");
  assert.equal(at(row, "actual_nzd"), "97.50");
  assert.equal(at(row, "nzd"), "97.50", "the usable column takes the real one");
  assert.equal(at(row, "nzd_source"), "actual");
});

test("a leg with no base rate leaves the cell blank, not zero", () => {
  const csv = buildExportCsv(BUDGET, [entry({ leg_rates: {} })]);
  const at = cols(csv);
  const row = parse(csv)[1];
  assert.equal(at(row, "nzd_estimate"), "");
  assert.equal(at(row, "nzd"), "");
  assert.equal(at(row, "nzd_source"), "");
  assert.match(csv, /could not be converted/, "and the reader is told");
});

test("a cash movement gets no estimate, but keeps a settled figure", () => {
  // A withdrawal is a funding event: its true cost belongs in actual_nzd, not
  // inferred from a planning rate.
  const csv = buildExportCsv(BUDGET, [
    entry({ entry_type: "withdrawal", category_name: null, budget_amount: 0, amount: 200000 }),
    entry({ entry_type: "withdrawal", category_name: null, budget_amount: 0, amount: 200000, actual_base: 95000 }),
  ]);
  const at = cols(csv);
  const [, a, b] = parse(csv);
  assert.equal(at(a, "nzd_estimate"), "");
  assert.equal(at(a, "nzd"), "");
  assert.equal(at(b, "nzd"), "950.00");
  assert.equal(at(b, "nzd_source"), "actual");
});

test("a cash movement is never filed under a category", () => {
  // It would otherwise read as spend against that category's allocation.
  const csv = buildExportCsv(BUDGET, [
    entry({ entry_type: "withdrawal", category_name: null, parent_name: null,
            budget_amount: 0, amount: 200000, actual_base: 95000 }),
  ]);
  assert.equal(cols(csv)(parse(csv)[1], "category_path"), "");
  assert.equal(totalFor(csv, "category", "(cash movements)"), "950.00");
  assert.equal(totalFor(csv, "category", "Peru"), null);
});

test("the category path names each level once", () => {
  const csv = buildExportCsv(BUDGET, [
    entry({ parent_name: "Pre-Program", category_name: "Groceries" }),
    entry({ parent_name: null, category_name: "Food" }),
    entry({ parent_name: null, category_name: "Peru" }),   // logged at the leg
  ]);
  const at = cols(csv);
  const [, a, b, c] = parse(csv);
  assert.equal(at(a, "category_path"), "Peru › Pre-Program › Groceries");
  assert.equal(at(b, "category_path"), "Peru › Food");
  assert.equal(at(c, "category_path"), "Peru", "not 'Peru › Peru'");
});

// ── totals ──────────────────────────────────────────────────────────────────

const totalsBlock = (csv) => {
  const lines = parse(csv);
  const start = lines.findIndex((l) => /^TOTALS/.test(l[0] || ""));
  return lines.slice(start + 2).filter((l) => l[0] && l[0] !== "note");
};
const totalFor = (csv, scope, name) => {
  const row = totalsBlock(csv).find((l) => l[0] === scope && l[1] === name);
  return row ? row[3] : null;
};

test("totals are grouped by leg, category and method, then overall", () => {
  const csv = buildExportCsv(BUDGET, [
    entry({ budget_amount: 21000, payment_method: "cash" }),                    // NZD 100
    entry({ budget_amount: 10500, payment_method: "card" }),                    // NZD 50
    entry({ leg_name: "Ecuador", leg_currency: "USD", leg_rates: { NZD: 0.6 },
            budget_amount: 6000, category_name: "Transport", payment_method: "card" }), // NZD 100
  ]);
  assert.equal(totalFor(csv, "leg", "Peru"), "150.00");
  assert.equal(totalFor(csv, "leg", "Ecuador"), "100.00");
  assert.equal(totalFor(csv, "category", "Peru › Food"), "150.00");
  assert.equal(totalFor(csv, "category", "Ecuador › Transport"), "100.00");
  assert.equal(totalFor(csv, "method", "cash"), "100.00");
  assert.equal(totalFor(csv, "method", "card"), "150.00");
  const grand = totalsBlock(csv).find((l) => l[0] === "total");
  assert.equal(grand[3], "250.00");
  assert.equal(grand[2], "3", "and how many entries it covers");
});

test("the grand total is exactly the sum of the printed lines", () => {
  // Rounding per row and then totalling separately is how an export ends up
  // off by a cent and nobody can say which line is wrong.
  const rows = [
    entry({ budget_amount: 3333 }), entry({ budget_amount: 3333 }), entry({ budget_amount: 3333 }),
  ];
  const csv = buildExportCsv(BUDGET, rows);
  const at = cols(csv);
  const printed = parse(csv).slice(1, 1 + rows.length)
    .reduce((n, r) => n + Math.round(Number(at(r, "nzd")) * 100), 0);
  const grand = totalsBlock(csv).find((l) => l[0] === "total")[3];
  assert.equal(Math.round(Number(grand) * 100), printed);
});

test("a correction nets off the totals it belongs to", () => {
  const csv = buildExportCsv(BUDGET, [
    entry({ budget_amount: 21000 }),
    entry({ entry_type: "correction", budget_amount: -21000, description: "Duplicate" }),
  ]);
  assert.equal(totalFor(csv, "leg", "Peru"), "0.00");
  assert.equal(totalsBlock(csv).find((l) => l[0] === "total")[3], "0.00");
});

test("an unconvertible row is excluded from totals and reported, not counted as zero", () => {
  const csv = buildExportCsv(BUDGET, [
    entry({ budget_amount: 21000 }),
    entry({ leg_name: "Fiji", leg_currency: "FJD", leg_rates: {}, budget_amount: 50000 }),
  ]);
  assert.equal(totalsBlock(csv).find((l) => l[0] === "total")[3], "100.00");
  assert.equal(totalFor(csv, "leg", "Fiji"), null, "no total for a leg that can't be converted");
  assert.match(csv, /1 row could not be converted/);
});

test("the export says how much of the total is estimated", () => {
  const csv = buildExportCsv(BUDGET, [
    entry({ budget_amount: 21000 }),                    // estimate, NZD 100
    entry({ budget_amount: 21000, actual_base: 9000 }), // settled,  NZD 90
  ]);
  assert.match(csv, /100\.00 of the 190\.00 total is estimated/);
});

// ── mechanics ───────────────────────────────────────────────────────────────

test("totals sit below a blank line, under their own header", () => {
  // So selecting the entries and summing the nzd column can't pick up a
  // subtotal and double-count it.
  const lines = buildExportCsv(BUDGET, [entry()]).split("\n");
  const blank = lines.findIndex((l, i) => i > 0 && l === "");
  assert.ok(blank > 0, "there is a blank separator");
  assert.match(lines[blank + 1], /^TOTALS \(NZD\)/);
  assert.match(lines[blank + 2], /^scope,name,entries,nzd/);
});

test("commas and quotes in a description survive the round trip", () => {
  const csv = buildExportCsv(BUDGET, [entry({ description: 'Bus, "express", Cusco' })]);
  const at = cols(csv);
  assert.equal(at(parse(csv)[1], "description"), 'Bus, "express", Cusco');
});

test("every row has exactly as many cells as the header", () => {
  const csv = buildExportCsv(BUDGET, [entry(), entry({ leg_rates: {} })]);
  const lines = parse(csv);
  const width = lines[0].length;
  lines.forEach((l, i) => {
    if (l.length === 1 && l[0] === "") return;  // the blank separator
    assert.equal(l.length, width, `line ${i + 1} has ${l.length} cells, not ${width}`);
  });
});

test("an empty budget still produces a readable file", () => {
  const csv = buildExportCsv(BUDGET, []);
  assert.match(csv, /^date,leg,type/);
  assert.match(csv, /TOTALS \(NZD\)/);
  assert.equal(totalsBlock(csv).find((l) => l[0] === "total")[3], "0.00");
});

test("the base currency is taken from the budget, not hardcoded", () => {
  const csv = buildExportCsv({ name: "X", base_currency: "AUD" },
    [entry({ leg_rates: { AUD: 2 } })]);
  assert.match(csv, /aud_estimate/);
  assert.match(csv, /actual_aud/);
  assert.match(csv, /TOTALS \(AUD\)/);
  assert.equal(cols(csv)(parse(csv)[1], "aud"), "105.00");
});

test("asDecimal respects each currency's minor units", () => {
  assert.equal(asDecimal(12345, "NZD"), "123.45");
  assert.equal(asDecimal(12345, "JPY"), "12345");
  assert.equal(asDecimal(12345, "KWD"), "12.345");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
