/**
 * cash-report-pdf.smoke.mjs
 *
 * Renders /cash-forecast/ in headless Chromium against a mocked
 * /api/cash-forecast, picks a fiscal year, clicks Export PDF, and reads the
 * downloaded file back as text.
 *
 * cash-report.test.mjs argues the arithmetic. This covers the rest: that the
 * vendored libraries load from ./vendor/, that the button produces a real PDF
 * download, and that the figures in it are the figures on the page — the
 * failure modes being a silent no-op, a blank file, or "undefined" in a cell.
 *
 *   node test/cash-report-pdf.smoke.mjs [--keep <dir>]
 *
 * Needs `pdftotext` (poppler) on the PATH to read the PDF back.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createServer } from "node:http";
import { readFile, mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { seedAssumptions } from "../cash-forecast/seed.mjs";
import { buildForecast } from "../cash-forecast/engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keepAt = process.argv.includes("--keep") ? process.argv[process.argv.indexOf("--keep") + 1] : null;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": `${TYPES[extname(file)] ?? "text/plain"}; charset=utf-8` });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/cash-forecast/`;

/* ---- fixtures: the seeded model, with April–August closed from Xero ---- */

const assumptions = { ...seedAssumptions(2026), actualsThroughMonth: "2026-08" };
const actualsByMonth = {
  "2026-08": {
    source: "Xero Bank Summary",
    byCurrency: {
      NZD: { opening: -103_207, received: 885_907, spent: 806_470, closing: -23_770 },
      USD: { opening: 175_739, received: 412_523, spent: 358_587, closing: 229_675 },
    },
  },
};
const today = { today: new Date("2026-10-12T00:00:00Z") };
const forecast = buildForecast(assumptions, actualsByMonth, today);
const forecastOnly = buildForecast({ ...assumptions, actualsThroughMonth: null }, {}, today);

/* ---- drive it ---- */

let failures = 0;
const check = (ok, msg) => { if (ok) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(() => chromium.launch());
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// Chart.js and Tailwind come from CDNs; the test must not depend on them.
await page.route(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|pacificdiscovery\.org/,
  (route) => route.fulfill({ status: 200, body: "" }));

await page.route("**/api/cash-forecast*", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    assumptions, forecast, forecastOnly, actualsByMonth, canEdit: true,
    email: "smoke@example.com", actuals: null, actualMonthsAvailable: ["2026-08"],
  }),
}));

await page.goto(pageUrl, { waitUntil: "networkidle" });

const options = await page.locator("#pdffy option").allInnerTexts();
check(options.length >= 2, `the picker offers the complete years (${options.join(" | ")})`);
check(/FY 2026\/27/.test(options[0]) && !/no programs/.test(options[0]), "the model year comes first, unflagged");
check(/FY 2027\/28 \(no programs\)/.test(options[1]), "an empty year is flagged in the picker");

const outDir = await mkdtemp(join(tmpdir(), "cash-pdf-"));
const text = async (fyValue) => {
  await page.selectOption("#pdffy", String(fyValue));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportpdf")]);
  const path = join(outDir, dl.suggestedFilename());
  await dl.saveAs(path);
  const head = (await readFile(path)).subarray(0, 5).toString();
  return { name: dl.suggestedFilename(), path, head, txt: execFileSync("pdftotext", ["-layout", path, "-"]).toString() };
};

/* The model year. */
{
  const { name, path, head, txt } = await text(2026);
  check(head === "%PDF-", "the download is a PDF");
  check(/^PD-cash-flow-FY26-27-\d{4}-\d{2}-\d{2}\.pdf$/.test(name), `named by fiscal year (${name})`);
  check(/Cash flow report · FY 2026\/27/.test(txt), "titled with the fiscal year");
  check(/1 April 2026 – 31 March 2027/.test(txt), "states the period");
  check(/Monthly cash flow/.test(txt) && /Apr 26/.test(txt) && /Mar 27/.test(txt), "has the monthly table, April to March");
  check(/Actual/.test(txt), "closed months are marked actual");
  check(/NZD vs forecast/.test(txt), "includes the variance row");
  check(/Programs departing in the year/.test(txt) && /NZA/.test(txt), "lists the year's programs");
  check(/Page 1 of \d/.test(txt) && /Confidential/.test(txt), "has the running footer");
  check(!/undefined|NaN|Infinity/.test(txt), "no undefined or NaN anywhere");
  const closing = Math.round(forecast.months[11].baseClosing);
  const shown = closing < 0 ? `(${Math.abs(closing).toLocaleString("en-NZ")})` : closing.toLocaleString("en-NZ");
  check(txt.includes(shown), `the 31 March NZD account (${shown}) is in the PDF`);
  check(!/DRAFT/.test(txt), "a saved model is not marked draft");
  if (keepAt) await copyFile(path, join(keepAt, name));
}

/* The runway year. */
{
  const { name, txt } = await text(2027);
  check(/FY27-28/.test(name), `second year named for itself (${name})`);
  check(/FY 2027\/28/.test(txt) && /Apr 27/.test(txt), "second year shows its own months");
  check(/No programs are entered for FY 2027\/28/.test(txt), "and says nothing is entered");
}

/* Unsaved edits export as a draft. */
{
  await page.click('button[data-tab="programs"]');
  const pax = page.locator('tr[data-i] input[data-f="paxForecast"]').first();
  await pax.fill("99");
  await pax.dispatchEvent("change");
  const { name, txt } = await text(2026);
  check(/-DRAFT\.pdf$/.test(name), `unsaved changes give a draft filename (${name})`);
  check(/DRAFT — this report includes unsaved changes/.test(txt), "and a draft banner");
}

check(!(await page.locator(".warnings", { hasText: "PDF export failed" }).count()), "no export error shown");
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nCash report PDF smoke test passed.");
process.exit(failures ? 1 : 0);
