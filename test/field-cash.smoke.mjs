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
  { id: "leg_thai", budget_id: "thailand", name: "Thailand", parent_id: null,
    allocated: 500000, sort_order: 1, depth: 1, currency: "THB", rates: { NZD: 21.5 } },
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
  spend: [{ budget_id: "peru", category_id: "cat_food", spent: 75000, n: 4 }],
  receipts: [{ budget_id: "peru", n: 2 }],
  codes: [{ email: "katie@pd.org", code_set_at: "2026-01-20T00:00:00Z", last_login_at: null, locked_until: null }],
  cash: cash.byBudget.filter((r) => r.budget_id === "peru"),
  cashByPerson: cash.byPerson,
  cashUnresolved: 0,
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
await page.route("**/api/budget-admin**", (route) => route.fulfill({ json: payload }));
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
  assert.match(leg, /PEN 13,738\.80/, `remaining missing from "${leg}"`);       // 14,488.80 − 750
  assert.match(leg, /of PEN 14,488\.80/, `allocation missing from "${leg}"`);
  assert.match(leg, /≈ NZD/, "the base-currency conversion should survive alongside it");
});

await check("a leg carries its own progress bar", async () => {
  // One per leg: Peru on the open card, Thailand on the other.
  assert.equal(await page.locator(".leg-head .minibar").count(), 2);
  const width = await page.locator(".leg-head .minibar span").first()
    .evaluate((el) => el.style.width);
  assert.match(width, /^5\.17/, `750 spent of 14,488.80 is ~5%, got ${width}`);
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
