// test/field-cash.smoke.mjs
//
// Renders the real field-budget page against a stubbed API and checks the cash
// figures that actually reach the screen — the collapsed-card chip, the per
// instructor table, and the pill beside each name.
//
// Run: npm run test:cash-ui

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { foldCash } from "../netlify/functions/_shared/field-cash.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Two budgets, because the page auto-expands when there is exactly one — and
// the point of the chip is that it reads while the card is still shut. The
// second one is also the card-only case: no cash entries, so no cash furniture.
const budgets = [
  { id: "peru", name: "Peru — Feb 2026", base_currency: "NZD", currency: null,
    default_rate: 3.34, funded_base: 5000000, starts_on: "2026-02-02",
    ends_on: "2026-03-04", status: "active", rates: {} },
  { id: "thailand", name: "Thailand — Jun 2026", base_currency: "NZD", currency: null,
    default_rate: 1, funded_base: 2000000, starts_on: "2026-06-01",
    ends_on: "2026-06-30", status: "active", rates: {} },
];
const categories = [
  { id: "leg_peru", budget_id: "peru", name: "Peru", parent_id: null, allocated: 0,
    sort_order: 1, depth: 1, currency: "PEN", rates: { NZD: 2.1, USD: 3.34 } },
  { id: "cat_food", budget_id: "peru", name: "Food", parent_id: "leg_peru",
    allocated: 1448880, sort_order: 1, depth: 2, rates: {} },
  { id: "cat_groceries", budget_id: "peru", name: "Groceries", parent_id: "cat_food",
    allocated: 800000, sort_order: 1, depth: 3, rates: {} },
  { id: "leg_thai", budget_id: "thailand", name: "Thailand", parent_id: null,
    allocated: 500000, sort_order: 1, depth: 1, currency: "THB", rates: { NZD: 21.5 } },
];

// The ledger dialog fetches these separately.
const entries = [
  { id: "e1", budget_id: "peru", category_id: "cat_groceries", email: "katie@pd.org",
    entry_type: "expense", spent_on: "2026-02-10", amount: 12000, currency: "PEN", rate: 1,
    budget_amount: 12000, payment_method: "cash", description: "Market run",
    leg_name: "Peru", leg_currency: "PEN", receipt_link: null, corrects_id: null },
  { id: "e2", budget_id: "peru", category_id: "cat_groceries", email: "manuel@pd.org",
    entry_type: "expense", spent_on: "2026-02-11", amount: 8000, currency: "PEN", rate: 1,
    budget_amount: 8000, payment_method: "cash", description: "Fruit",
    leg_name: "Peru", leg_currency: "PEN", receipt_link: "https://drive/x", corrects_id: null },
  { id: "e3", budget_id: "peru", category_id: "cat_food", email: "katie@pd.org",
    entry_type: "expense", spent_on: "2026-02-12", amount: 25000, currency: "PEN", rate: 1,
    budget_amount: 25000, payment_method: "card", description: "Group dinner",
    leg_name: "Peru", leg_currency: "PEN", receipt_link: null, corrects_id: null },
  { id: "e4", budget_id: "peru", category_id: null, email: "katie@pd.org",
    entry_type: "withdrawal", spent_on: "2026-02-09", amount: 200000, currency: "PEN", rate: 1,
    budget_amount: 0, payment_method: "cash", description: "ATM, Cusco",
    leg_name: null, leg_currency: null, receipt_link: null, corrects_id: null },
  { id: "e5", budget_id: "peru", category_id: "cat_gone", email: "katie@pd.org",
    entry_type: "expense", spent_on: "2026-02-08", amount: 4000, currency: "PEN", rate: 1,
    budget_amount: 4000, payment_method: "cash", description: "Old category",
    leg_name: "Peru", leg_currency: "PEN", receipt_link: null, corrects_id: null },
  { id: "e6", budget_id: "peru", category_id: "cat_groceries", email: "katie@pd.org",
    entry_type: "correction", spent_on: "2026-02-11", amount: -8000, currency: "PEN", rate: 1,
    budget_amount: -8000, payment_method: "cash", description: "Duplicate",
    leg_name: "Peru", leg_currency: "PEN", receipt_link: null, corrects_id: "e2" },
];
const assignments = [
  { budget_id: "peru", email: "katie@pd.org", role: "instructor" },
  { budget_id: "peru", email: "manuel@pd.org", role: "instructor" },
];

// katie: drew PEN 2,000, spent PEN 450 cash + PEN 300 card, exchanged PEN 1,000
//        into USD 300  →  PEN 550 and USD 300 in hand
// manuel: drew PEN 1,500, spent nothing  →  PEN 1,500
// katie also holds PEN 800 on a different programme, so her person-wide total
// is higher than this budget's figure.
const ledger = [
  { budget_id: "peru", email: "katie@pd.org", currency: "PEN", kind: "withdrawal", method: "cash", total: 200000, n: 1 },
  { budget_id: "peru", email: "katie@pd.org", currency: "PEN", kind: "expense", method: "cash", total: 45000, n: 3 },
  { budget_id: "peru", email: "katie@pd.org", currency: "PEN", kind: "expense", method: "card", total: 30000, n: 1 },
  { budget_id: "peru", email: "katie@pd.org", currency: "PEN", kind: "exchange", method: "cash", total: -100000, n: 1 },
  { budget_id: "peru", email: "katie@pd.org", currency: "USD", kind: "exchange", method: "cash", total: 30000, n: 1 },
  { budget_id: "peru", email: "manuel@pd.org", currency: "PEN", kind: "withdrawal", method: "cash", total: 150000, n: 1 },
  { budget_id: "ecuador", email: "katie@pd.org", currency: "PEN", kind: "withdrawal", method: "cash", total: 80000, n: 1 },
];
const cash = foldCash(ledger);

const payload = {
  budgets, categories, assignments,
  spend: [
    { budget_id: "peru", category_id: "cat_groceries", spent: 12000, n: 3 },
    { budget_id: "peru", category_id: "cat_food", spent: 25000, n: 1 },
  ],
  receipts: [{ budget_id: "peru", n: 2 }],
  codes: [{ email: "katie@pd.org", code_set_at: "2026-01-20T00:00:00Z", last_login_at: null, locked_until: null }],
  cash: cash.byBudget.filter((r) => r.budget_id === "peru"),
  cashByPerson: cash.byPerson,
  cashUnresolved: 0,
  // Quoted against NZD. The Peru leg stores 2.10 PEN per NZD; the market says
  // 2.52, so the stored rate is ~17% out and should be flagged.
  market: { base: "NZD", date: "2026-09-22", source: "ECB via Frankfurter", rates: { PEN: 2.52, THB: 21.4 } },
  generatedAt: new Date().toISOString(),
};

const server = http.createServer((req, res) => {
  const file = req.url === "/" ? "/field-budget/index.html" : req.url.split("?")[0];
  try {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(ROOT, file)));
  } catch { res.writeHead(404).end("nope"); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const posted = [];
await page.route("**/api/budget-admin**", (route) => {
  const url = route.request().url();
  if (route.request().method() === "POST") {
    posted.push(JSON.parse(route.request().postData() || "{}"));
    return route.fulfill({ json: { id: "copy1", name: "copy", categories: 3, assigned: [] } });
  }
  if (/action=entries/.test(url)) return route.fulfill({ json: { entries } });
  if (/action=fx/.test(url)) {
    return route.fulfill({ json: { market: { base: "PEN", date: "2026-09-22", source: "ECB via Frankfurter", rates: { NZD: 0.45, USD: 0.27 } } } });
  }
  return route.fulfill({ json: payload });
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push([name, null]); }
  catch (err) { checks.push([name, err.message]); }
};

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".bcard", { timeout: 10000 });

await check("the collapsed card shows cash on hand per currency", async () => {
  const chip = page.locator(".cash-chip").first();
  const text = (await chip.textContent()).replace(/\s+/g, " ").trim();
  assert.match(text, /cash on hand/i);
  assert.match(text, /PEN\s*2,050\.00/, `PEN total wrong in "${text}"`);   // 550 + 1500
  assert.match(text, /USD\s*300\.00/, `USD total wrong in "${text}"`);
});

await check("the chip is visible without opening the card", async () => {
  const card = page.locator('.bcard[data-budget="peru"]');
  assert.equal(await card.evaluate((el) => el.open), false, "card should start collapsed");
  assert.equal(await card.locator(".cash-chip").isVisible(), true);
});

await check("a budget with no cash entries grows no cash furniture", async () => {
  const card = page.locator('.bcard[data-budget="thailand"]');
  assert.equal(await card.locator(".cash-chip").count(), 0);
  assert.equal(await card.locator(".cash table").count(), 0);
});

await page.locator('.bcard[data-budget="peru"] summary').click();
await page.waitForSelector(".cash table", { timeout: 5000 });

await check("each instructor gets a row per currency with in, out, spent and held", async () => {
  const rows = await page.locator(".cash tbody tr").allTextContents();
  const flat = rows.map((r) => r.replace(/\s+/g, " ").trim());
  assert.equal(flat.length, 3, `expected katie PEN, katie USD, manuel PEN — got ${JSON.stringify(flat)}`);
  const katiePen = flat.find((r) => r.startsWith("katie") && r.includes("PEN"));
  assert.match(katiePen, /PEN 2,000\.00/, "cash in — the withdrawal in full, not netted against the exchange");
  assert.match(katiePen, /PEN 1,000\.00/, "cash out — the exchange into dollars");
  assert.match(katiePen, /PEN 450\.00/, "spent — the card charge must not appear");
  assert.match(katiePen, /PEN 550\.00/, "held");
});

await check("a card charge is absent from the cash table", async () => {
  const katiePen = (await page.locator(".cash tbody tr").first().textContent()).replace(/\s+/g, " ");
  assert.ok(!katiePen.includes("300.00") || katiePen.includes("PEN 550.00"),
    "PEN 300 card spend should not be counted as cash");
});

await check("cash carried from another programme is called out", async () => {
  const note = await page.locator(".cash .elsewhere", { hasText: "across all budgets" }).first().textContent();
  assert.match(note, /PEN\s*1,350\.00/, `katie holds 550 here + 800 elsewhere, got "${note}"`);
});

await check("the table totals each currency across instructors", async () => {
  const feet = (await page.locator(".cash tfoot").textContent()).replace(/\s+/g, " ");
  assert.match(feet, /PEN.*2,050\.00/);
  assert.match(feet, /USD.*300\.00/);
});

await check("each instructor pill carries what they're holding", async () => {
  const katie = (await page.locator(".pill", { hasText: "katie@pd.org" }).textContent()).replace(/\s+/g, " ");
  assert.match(katie, /PEN\s*550\.00/);
  assert.match(katie, /USD\s*300\.00/);
  const manuel = (await page.locator(".pill", { hasText: "manuel@pd.org" }).textContent()).replace(/\s+/g, " ");
  assert.match(manuel, /PEN\s*1,500\.00/);
});

await check("each leg shows what's left of its own allocation", async () => {
  const leg = (await page.locator(".leg-head").first().textContent()).replace(/\s+/g, " ").trim();
  assert.match(leg, /^Peru/, `unexpected leg header "${leg}"`);
  assert.match(leg, /PEN 7,630\.00/, `remaining missing from "${leg}"`);        // 8,000 − 370
  assert.match(leg, /of PEN 8,000\.00/, `allocation missing from "${leg}"`);
  assert.match(leg, /≈ NZD/, "the base-currency conversion should survive alongside it");
});

await check("a leg carries its own progress bar", async () => {
  // One per leg: Peru on the open card, Thailand on the other.
  assert.equal(await page.locator(".leg-head .minibar").count(), 2);
  const width = await page.locator(".leg-head .minibar span").first()
    .evaluate((el) => el.style.width);
  assert.match(width, /^4\.625/, `370 spent of 8,000 is ~4.6%, got ${width}`);
});

// ── ledger, grouped by budget category ──────────────────────────────────────

await page.locator('.bcard[data-budget="peru"] [data-ledger]').click();
await page.waitForSelector(".lg-leg", { timeout: 5000 });

await check("entries open grouped by category, under their leg", async () => {
  const legs = await page.locator(".lg-leg").allTextContents();
  assert.match(legs[0].replace(/\s+/g, " ").trim(), /^Peru PEN/, `first section should be the leg, got "${legs[0]}"`);
  const cats = await page.locator(".lg-cat .nm").allTextContents();
  assert.deepEqual(cats, ["Food", "Groceries"], "tree order, and a parent with its own direct spend gets its own group");
});

await check("a subcategory shows its path", async () => {
  const crumb = await page.locator('.lg-cat[data-cat="cat_groceries"] .crumb').first().textContent();
  assert.match(crumb, /Food ›/, `expected the parent in the breadcrumb, got "${crumb}"`);
});

await check("a leaf group reads its subtotal against its allocation", async () => {
  const sub = (await page.locator('.lg-cat[data-cat="cat_groceries"] .sub').textContent()).replace(/\s+/g, " ");
  // 120 + 80 − 80 corrected = PEN 120, against Groceries' own PEN 8,000
  assert.match(sub, /PEN 120\.00 of PEN 8,000\.00/, `got "${sub}"`);
});

await check("a parent with subcategories doesn't compare a direct subtotal to a roll-up", async () => {
  // Food's allocation on the card is the sum of its children. Printing
  // "PEN 250.00 of PEN 8,000.00" here would invite subtracting one from the
  // other, and the difference would mean nothing.
  const sub = (await page.locator('.lg-cat[data-cat="cat_food"] .sub').textContent()).replace(/\s+/g, " ").trim();
  assert.equal(sub, "PEN 250.00 logged directly here", `got "${sub}"`);
});

await check("column headers appear once, on the first group shown", async () => {
  const heads = await page.locator("#ledgerBody .lg-tbl thead").count();
  // One for the first category group, one for the differently-shaped
  // cash-movements and uncategorised sections.
  assert.equal(heads, 3, "headers should not repeat above every category");
  const firstTable = page.locator("#ledgerBody .lg-tbl").first();
  assert.equal(await firstTable.locator("thead").count(), 1, "the first group is the one that carries them");
});

await check("every row says how it was paid for", async () => {
  const head = await page.locator("#ledgerBody .lg-tbl thead").first().textContent();
  assert.match(head, /Method/);
  // One pill per row, nothing blank — a column of dashes would read as
  // missing data rather than as a cash movement.
  const pills = await page.locator("#ledgerBody .lg-tbl tbody .pm").count();
  const rows = await page.locator("#ledgerBody .lg-tbl tbody tr").count();
  assert.equal(pills, rows);
});

await check("cash and card are told apart, and the card charge is the card one", async () => {
  const cardRow = page.locator("#ledgerBody .lg-tbl tbody tr", { hasText: "Group dinner" });
  assert.equal(await cardRow.locator(".pm-card").count(), 1, "the card expense");
  const cashRow = page.locator("#ledgerBody .lg-tbl tbody tr", { hasText: "Market run" });
  assert.equal(await cashRow.locator(".pm-cash").count(), 1, "the cash expense");
  // A withdrawal has no choice about it but still reads as cash.
  const atm = page.locator("#ledgerBody .lg-tbl tbody tr", { hasText: "ATM, Cusco" });
  assert.equal(await atm.locator(".pm-cash").count(), 1);
});

await check("searching by payment method works", async () => {
  await page.fill("#lgSearch", "card");
  await page.waitForTimeout(150);
  const rows = await page.locator("#ledgerBody .lg-tbl tbody tr").count();
  assert.equal(rows, 1, "only the card charge");
  assert.match(await page.locator("#ledgerBody").textContent(), /Group dinner/);
  await page.fill("#lgSearch", "");
  await page.waitForTimeout(150);
});

await check("a corrected entry and its correction both stay, struck through", async () => {
  assert.equal(await page.locator(".lg-tbl tr.voided").count(), 1, "the voided original");
  const body = await page.locator("#ledgerBody").textContent();
  assert.match(body, /correction/);
  assert.match(body, /corrected/);
});

await check("cash movements get their own section rather than vanishing", async () => {
  const sections = (await page.locator(".lg-leg").allTextContents()).map((t) => t.replace(/\s+/g, " "));
  assert.ok(sections.some((t) => /Cash movements/.test(t)), JSON.stringify(sections));
  const body = await page.locator("#ledgerBody").textContent();
  assert.match(body, /ATM, Cusco/);
});

await check("an entry on a deleted category is surfaced, not dropped", async () => {
  const sections = (await page.locator(".lg-leg").allTextContents()).map((t) => t.replace(/\s+/g, " "));
  assert.ok(sections.some((t) => /Uncategorised/.test(t)), JSON.stringify(sections));
  assert.match(await page.locator("#ledgerBody").textContent(), /Old category/);
});

await check("every entry appears exactly once across the groups", async () => {
  // The failure that would matter: a row quietly falling between two groups.
  const rows = await page.locator("#ledgerBody .lg-tbl tbody tr").count();
  assert.equal(rows, entries.length, "grouped view must account for every entry");
});

await check("the date view still works and shows leg and category columns", async () => {
  await page.click("#byDate");
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".lg-leg").count(), 0, "no group headings in the flat view");
  const rows = await page.locator("#ledgerBody .lg-tbl tbody tr").count();
  assert.equal(rows, entries.length);
  const head = await page.locator("#ledgerBody .lg-tbl thead").textContent();
  assert.match(head, /Leg/);
  assert.match(head, /Category/);
  await page.click("#byCat");
  await page.waitForTimeout(150);
  assert.ok(await page.locator(".lg-leg").count() > 0, "toggling back restores the grouping");
});

// ── search and the corrections toggle ───────────────────────────────────────

const shownRows = () => page.locator("#ledgerBody .lg-tbl tbody tr").count();

await check("search narrows to matching entries and says how many", async () => {
  await page.fill("#lgSearch", "market");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 1);
  assert.match(await page.locator("#lgCount").textContent(), /1 of 6 entries match/);
  assert.match(await page.locator("#ledgerBody").textContent(), /Market run/);
});

await check("a search hit is highlighted where it matched", async () => {
  const hit = await page.locator(".lg-hit").first().textContent();
  assert.match(hit.toLowerCase(), /market/);
});

await check("groups with no match drop out entirely", async () => {
  // Only Groceries should survive "market" — no empty headings left behind.
  const cats = await page.locator(".lg-cat .nm").allTextContents();
  assert.deepEqual(cats, ["Groceries"]);
  assert.equal(await page.locator(".lg-leg").count(), 1, "the cash-movements section should go too");
});

await check("a filtered subtotal never sits next to an allocation", async () => {
  // Comparing "what matched" to "what was budgeted" would be two different
  // populations in one sentence.
  const sub = (await page.locator('.lg-cat[data-cat="cat_groceries"] .sub').textContent()).replace(/\s+/g, " ").trim();
  assert.equal(sub, "PEN 120.00 in 1 shown", `got "${sub}"`);
});

await check("search matches people and amounts, not just descriptions", async () => {
  await page.fill("#lgSearch", "manuel");
  await page.waitForTimeout(150);
  assert.ok(await shownRows() >= 1, "by instructor");
  await page.fill("#lgSearch", "181.27");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 0, "no such amount in this fixture");
  await page.fill("#lgSearch", "80.00");
  await page.waitForTimeout(150);
  assert.ok(await shownRows() >= 1, "by the amount as it's displayed");
});

await check("every term has to match, so a second word narrows", async () => {
  await page.fill("#lgSearch", "katie market");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 1);
  await page.fill("#lgSearch", "manuel market");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 0, "manuel didn't log the market run");
  assert.match(await page.locator("#ledgerBody").textContent(), /Nothing matches/);
});

await check("clearing the search brings everything back", async () => {
  await page.fill("#lgSearch", "");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), entries.length);
});

await check("hiding corrections drops the correction and the row it voids", async () => {
  await page.uncheck("#lgCorr");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), entries.length - 2, "both halves of the pair go");
  assert.equal(await page.locator(".lg-tbl tr.voided").count(), 0);
  const body = await page.locator("#ledgerBody").textContent();
  assert.ok(!/Duplicate/.test(body), "the correction itself is gone");
  assert.ok(!/Fruit/.test(body), "and so is the entry it voided");
  assert.match(await page.locator("#lgCount").textContent(), /2 corrected rows hidden · totals unchanged/);
});

await check("hiding corrections moves no subtotal", async () => {
  // The pair sums to zero, so this is a promise the UI makes and should keep.
  const sub = (await page.locator('.lg-cat[data-cat="cat_groceries"] .sub').textContent()).replace(/\s+/g, " ").trim();
  assert.equal(sub, "PEN 120.00 of PEN 8,000.00", `got "${sub}"`);
});

await check("the corrections toggle applies to the date view too", async () => {
  await page.click("#byDate");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), entries.length - 2);
  await page.click("#byCat");
  await page.waitForTimeout(150);
  await page.check("#lgCorr");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), entries.length);
});

await check("search and the corrections toggle compose", async () => {
  await page.uncheck("#lgCorr");
  await page.fill("#lgSearch", "fruit");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 0, "a voided entry stays hidden even when searched for");
  await page.check("#lgCorr");
  await page.waitForTimeout(150);
  assert.equal(await shownRows(), 1);
  await page.fill("#lgSearch", "");
  await page.waitForTimeout(150);
});

await check("reopening the ledger starts from a clear search", async () => {
  await page.fill("#lgSearch", "market");
  await page.waitForTimeout(100);
  await page.click("#closeLedger");
  await page.locator('.bcard[data-budget="peru"] [data-ledger]').click();
  await page.waitForSelector(".lg-leg", { timeout: 5000 });
  assert.equal(await page.inputValue("#lgSearch"), "", "a search is about one question, not a standing filter");
  assert.equal(await shownRows(), entries.length);
  await page.click("#closeLedger");
});

// ── planning-rate drift, and duplicating a budget ───────────────────────────

await check("a planning rate that has drifted from the market is flagged", async () => {
  const chip = page.locator('.bcard[data-budget="peru"] .drift').first();
  assert.equal(await chip.count(), 1);
  assert.match((await chip.textContent()).trim(), /-17% vs market/);
  assert.match(await chip.getAttribute("title"), /market is around 2\.5200/);
});

await check("a leg whose rate matches the market is left alone", async () => {
  // Thailand stores 21.5 against a market 21.4 — well inside the threshold, and
  // a chip on every leg would train people to ignore all of them.
  assert.equal(await page.locator('.bcard[data-budget="thailand"] .drift').count(), 0);
});

await check("duplicating suggests next year's name and copies no entries", async () => {
  await page.locator('.bcard[data-budget="peru"] [data-duplicate]').click();
  await page.waitForSelector("#dupDlg[open]", { timeout: 5000 });
  assert.equal(await page.inputValue("#d-name"), "Peru — Feb 2027", "the year steps forward");
  assert.equal(await page.inputValue("#d-start"), "", "dates start blank, not last season's");
  assert.equal(await page.isChecked("#d-people"), false, "instructors are opt-in");
  assert.match(await page.locator("#dupDlg .hint").last().textContent(), /No entries are copied/);
});

await check("the duplicate request carries what the dialog showed", async () => {
  posted.length = 0;
  await page.fill("#d-name", "Peru — Feb 2027");
  await page.check("#d-people");
  await page.click("#d-save");
  await page.waitForTimeout(400);
  const body = posted.find((b) => b.budget_id);
  assert.ok(body, "a duplicate was posted");
  assert.equal(body.name, "Peru — Feb 2027");
  assert.equal(body.copy_assignments, true);
  assert.equal(body.starts_on, null);
});

await check("no uncaught page errors", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();

let failed = 0;
for (const [name, err] of checks) {
  if (err) { failed++; console.error(`  ✗ ${name}\n    ${err}`); }
  else console.log(`  ✓ ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
