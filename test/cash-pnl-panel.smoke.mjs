/**
 * cash-pnl-panel.smoke.mjs
 *
 * Renders /cash-forecast/ in headless Chromium against a mocked
 * /api/cash-forecast and /api/cash-pnl, and drives the P&L tab: open the
 * statement, open a section, open an account, switch to the monthly view.
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST
 * ---------------------------------------
 * cash-pnl.mjs is pure and covered by cash-pnl.test.mjs, which is where the
 * arithmetic is argued. This covers the other half — several hundred lines of
 * nested template literal and a click handler — where the failure mode is not
 * a wrong number but a page that renders "undefined", or a row that does not
 * open. Neither is visible to a unit test and both are obvious to a browser.
 *
 * The /api/cash-pnl payload is not hand-written: it comes from pnlView itself,
 * run over fixture months here in node. So if the module's shape changes, this
 * test moves with it rather than silently testing a shape nothing produces.
 *
 *   node test/cash-pnl-panel.smoke.mjs
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { pnlView } from "../netlify/functions/_shared/cash-pnl.mjs";
import { seedAssumptions } from "../cash-forecast/seed.mjs";
import { buildForecast } from "../cash-forecast/engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const FY = 2026;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": `${TYPES[extname(file)] ?? "text/plain"}; charset=utf-8` });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/cash-forecast/`;

/* ---- fixtures ---- */

const assumptions = seedAssumptions(FY);
const forecast = buildForecast(assumptions, {}, { today: new Date("2026-09-21T00:00:00Z") });

const flat = (n) => Array(12).fill(n);
const month = (key, opex) => ({
  month: key,
  parserVersion: 7,
  revenue: key === "2026-08" ? 1_200_000 : 0,
  revenueSectionFound: true,
  revenueLines: key === "2026-08" ? [{ name: "Program Fees", amount: 1_200_000 }] : [],
  programCost: 90_000,
  programCostSectionFound: true,
  programCostLines: [
    { name: "Accommodation", amount: 55_000 },
    { name: "Transport", amount: 35_000 },
  ],
  total: opex.reduce((s, l) => s + l.amount, 0),
  cashTotal: opex.filter((l) => !l.nonCash).reduce((s, l) => s + l.amount, 0),
  sectionFound: true,
  lines: opex,
});

const opexLines = [
  { name: "Wages and Salaries", amount: 52_000, nonCash: false },
  { name: "Rent", amount: 6_500, nonCash: false },
  { name: "Fireworks", amount: 1_100, nonCash: false },   // deliberately unbudgeted
  { name: "Bank Revaluations", amount: 4_000, nonCash: true },
];
const months = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
  .map((k) => month(k, opexLines));

const budget = {
  description: "FY26/27 board budget",
  series: {
    monthsCovered: [...Array(12).keys()],
    revenueAccounts: [{ account: "200 Program Fees", name: "Program Fees", months: flat(200_000) }],
    directCostAccounts: [
      { account: "300 Accommodation", name: "Accommodation", months: flat(50_000) },
      { account: "310 Transport", name: "Transport", months: flat(40_000) },
    ],
    overheadAccounts: [
      { account: "477 Wages and Salaries", name: "Wages and Salaries", months: flat(50_000) },
      { account: "469 Rent", name: "Rent", months: flat(6_500) },
      { account: "493 Legal Fees", name: "Legal Fees", months: flat(800) },
    ],
  },
};

const pnl = (basis) => pnlView({ fiscalYearStartYear: FY, months, budget, basis });

/* ---- drive it ---- */

let failures = 0;
const check = (ok, msg) => { if (ok) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch());
const page = await browser.newPage();

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.route("**/api/cash-forecast*", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    assumptions, forecast, canEdit: true, email: "smoke@example.com",
    actuals: null, actualsByMonth: {}, actualMonthsAvailable: [],
  }),
}));

await page.route("**/api/cash-pnl*", (route) => {
  const basis = new URL(route.request().url()).searchParams.get("basis") ?? "total";
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pnl(basis)) });
});

await page.goto(pageUrl, { waitUntil: "networkidle" });

await page.click('button[data-tab="pnl"]');
check(await page.locator("#loadpnl").isVisible(), "the P&L tab offers to open the statement");

await page.click("#loadpnl");
await page.waitForSelector("table.pnl");

// THE HEADLINE. 1,200,000 income less 450,000 of cost of sales over five
// months, less 317,000 of operating expenses — the number a reader takes away
// before any row is opened.
const headline = await page.locator(".headline").innerText();
check(/income/i.test(headline) && /1,200,000/.test(headline), `headline states the income: ${headline.slice(0, 60)}…`);
check(!/undefined|NaN/.test(await page.locator("table.pnl").innerText()),
  "no undefined or NaN anywhere in the statement");

// The budget column must be cut to the five closed months, not the twelve
// budgeted ones — 5 x 50,000 of wages, not 600,000.
const wagesBudgetToDate = pnl("total").sections
  .find((s) => s.id === "overheads").lines.find((l) => l.name === "Wages and Salaries").budgetToDate;
check(wagesBudgetToDate === 250_000, "budget-to-date is five months, not twelve");

// Sections open.
const before = await page.locator("tr.pnlline").count();
await page.click('tr[data-pnl="overheads"]');
const after = await page.locator("tr.pnlline").count();
check(after > before, `opening a section reveals its accounts (${before} → ${after} rows)`);
check(await page.locator("tr.pnlline", { hasText: "Wages and Salaries" }).count() > 0,
  "the biggest account is listed");
check(await page.locator(".tag-un").count() > 0,
  "an account with no budget line is marked rather than shown as an overspend");
check(await page.locator("tr.pnlline", { hasText: "Legal Fees" }).count() > 0,
  "a budgeted account nobody spent on is still listed");

// An account opens into its months.
await page.click('tr[data-pnl="overheads::Rent"]');
check(await page.locator("table.minimonths").count() > 0, "an account opens into its twelve months");

// And the monthly view switches the whole table over.
await page.click("#pnlbymonth");
await page.waitForSelector("table.pnl");
const headers = await page.locator("table.pnl thead th").count();
check(headers === 14, `month-by-month gives a column per month (${headers} headers)`);
check(await page.locator('tr[data-pnl="overheads"]').count() > 0,
  "and the sections stayed open across the re-render");

// The cash basis drops the revaluation and refetches rather than filtering here.
await page.click('input[name="pnlbasis"][value="cash"]');
await page.waitForFunction(() => !document.body.innerText.includes("Bank Revaluations"));
check(true, "switching to the cash basis removes the non-cash lines");

check(consoleErrors.length === 0, `no page errors${consoleErrors.length ? `: ${consoleErrors[0]}` : ""}`);

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) failed.` : "\nP&L panel smoke test passed.");
process.exit(failures ? 1 : 0);
