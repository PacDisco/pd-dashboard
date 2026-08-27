/**
 * marketing-performance.smoke.mjs
 *
 * Renders /marketing-performance/ in headless Chromium against mocked
 * /api/sales-funnel-data and /api/marketing-spend responses, and asserts the
 * page actually builds its KPIs, tables and charts.
 *
 * Why mocks: the real endpoints crawl live HubSpot and need a Neon URL, so a
 * smoke test that hit them would be slow, credential-bound and flaky. What
 * this proves is the contract between the page and those two payloads — which
 * is exactly what breaks when either function's shape changes.
 *
 * The fixture numbers are SYNTHETIC apart from the opportunity and sale
 * series, which are the real Pacific Discovery figures for Sep 2025 – Jul 2026
 * on the current definitions (application fee paid / deposit received).
 *
 *   node test/marketing-performance.smoke.mjs
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const pageFile = join(here, "..", "marketing-performance", "index.html");

// The page fetches same-origin '/api/...'. Over file:// those requests are
// blocked by the scheme before Playwright's router ever sees them, so the
// smoke test needs a real origin — a one-file static server is enough.
const server = createServer(async (req, res) => {
  try {
    const html = await readFile(pageFile);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/marketing-performance/`;

const MONTHS = [
  "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03", "2026-04",
  "2026-05", "2026-06", "2026-07", "2026-08",
];

// Real: opportunities = entered Application Fee Received; sales = entered Deposit Paid.
const OPPS  = [7, 8, 5, 13, 10, 3, 11, 12, 14, 28, 7, 0];
const SALES = [8, 3, 2, 13, 11, 3,  9,  9,  9, 19, 12, 0];
// Synthetic but plausible.
const LEADS   = [64, 71, 58, 96, 104, 62, 83, 77, 90, 88, 81, 44];
const TRAFFIC = [8100, 8700, 9300, 10200, 11400, 9600, 10100, 9200, 9800, 10688, 10043, 6200];

function spread(total, weights) {
  return MONTHS.map((_, i) => Math.round(total * weights[i % weights.length]));
}

const funnel = {
  months: MONTHS,
  traffic: TRAFFIC,
  trafficByChannel: {},
  trafficSource: "hubspot",
  trafficViewId: "16405",
  contacts: LEADS,
  opportunities: OPPS,
  salesViaDp: SALES,
  salesSkipDp: MONTHS.map(() => 0),
  totalSales: SALES,
  skippedDeals: [],
  bySource: {
    hubspot: {
      labels: ["Offline Sources", "Direct Traffic", "Paid Search", "Paid Social", "Organic Search", "Referrals"],
      contacts: {
        "Offline Sources": spread(60, [1, .9, .8]),
        "Direct Traffic":  spread(12, [1, .8, 1.1]),
        "Paid Search":     spread(4,  [1, 1, .5]),
        "Paid Social":     spread(0,  [0]),
        "Organic Search":  spread(3,  [1, .6, 1]),
        "Referrals":       spread(6,  [1, .7, .9]),
      },
      opportunities: {
        "Offline Sources": spread(6, [1, .8, .6]),
        "Direct Traffic":  spread(4, [1, .7, .9]),
        "Paid Search":     spread(1, [1, 0, 1]),
        "Paid Social":     spread(0, [0]),
        "Organic Search":  spread(0, [0]),
        "Referrals":       spread(1, [1, 0, 0]),
      },
      totalSales: {
        "Offline Sources": spread(5, [1, .8, .6]),
        "Direct Traffic":  spread(3, [1, .7, .9]),
        "Paid Search":     spread(1, [1, 0, 0]),
        "Paid Social":     spread(0, [0]),
        "Organic Search":  spread(0, [0]),
        "Referrals":       spread(1, [0, 1, 0]),
      },
    },
    jotform: {
      labels: ["Social Media", "Gap Year Association", "Go Abroad", "Word of Mouth", "Go Overseas", "TeenLife"],
      contacts: {
        "Social Media":         spread(20, [1, .8, .9]),
        "Gap Year Association": spread(4,  [1, 1, .8]),
        "Go Abroad":            spread(4,  [1, .7, 1]),
        "Word of Mouth":        spread(3,  [1, .9, .6]),
        "Go Overseas":          spread(2,  [1, 1, 1]),
        "TeenLife":             spread(1,  [1, 0, 1]),
      },
      opportunities: {
        "Social Media":         spread(3, [1, .6, .8]),
        "Gap Year Association": spread(1, [1, 0, 1]),
        "Go Abroad":            spread(0, [0]),
        "Word of Mouth":        spread(1, [1, 0, 0]),
        "Go Overseas":          spread(0, [0]),
        "TeenLife":             spread(0, [0]),
      },
      totalSales: {
        "Social Media":         spread(2, [1, .5, .8]),
        "Gap Year Association": spread(1, [0, 1, 0]),
        "Go Abroad":            spread(0, [0]),
        "Word of Mouth":        spread(1, [1, 0, 0]),
        "Go Overseas":          spread(0, [0]),
        "TeenLife":             spread(0, [0]),
      },
    },
  },
  offline: {
    // Shaped to match the real portal: Offline is the biggest bucket, a
    // minority of it is recoverable from the drill-downs, and the majority
    // has no drill-down at all.
    contacts: {
      total:       spread(60, [1, .9, .8]),
      recovered:   spread(25, [1, .9, .8]),
      unrecovered: spread(35, [1, .9, .8]),
      byChannel: {
        "Paid Social":     spread(10, [1, .9, .8]),
        "Referrals":       spread(9,  [1, .9, .8]),
        "Paid Search":     spread(4,  [1, .9, .8]),
        "AI Referrals":    spread(1,  [1, 1, 1]),
        "Email Marketing": spread(1,  [1, 1, 1]),
        "Not recoverable": spread(35, [1, .9, .8]),
      },
      byDetail: {
        "Facebook":               spread(10, [1, .9, .8]),
        "gooverseas.com":         spread(6,  [1, .9, .8]),
        "TeenLife":               spread(3,  [1, .9, .8]),
        "Performance Max - Europe": spread(4, [1, .9, .8]),
        "<script>x</script>":     spread(1,  [1, 1, 1]),
        "PD Newsletter":          spread(1,  [1, 1, 1]),
      },
      byRaw: {},
    },
    opportunities: {
      total: spread(6, [1, .8, .6]), recovered: spread(3, [1, .8, .6]), unrecovered: spread(3, [1, .8, .6]),
      byChannel: {}, byRaw: {},
      byDetail: { "Facebook": spread(2, [1, .8, .6]), "gooverseas.com": spread(2, [1, .8, .6]) },
    },
    totalSales: {
      total: spread(3, [1, .8, .6]), recovered: spread(2, [1, .8, .6]), unrecovered: spread(1, [1, .8, .6]),
      byChannel: {}, byRaw: {},
      byDetail: { "Facebook": spread(1, [1, .8, .6]), "gooverseas.com": spread(1, [1, .8, .6]) },
    },
    unrecoveredLabel: "Not recoverable",
    drilldownProps: ["original_source_drill_down_3", "original_source_drill_down_4", "original_source_drill_down_5"],
  },
  applications: {
    matched: spread(22, [1, .9, 1]),
    formIds: ["240277257210046"],
    available: true,
    noApplicationLabel: "(No application on file)",
    blankLabel: "(Application left blank)",
  },
  bySubSource: { detailFieldsByPrimary: {}, labels: {}, contacts: {}, opportunities: {}, salesViaDp: {}, salesSkipDp: {}, totalSales: {} },
  generatedAt: new Date().toISOString(),
};

// The bucket that used to swallow the panel. It must be present in the payload
// and absent from the chart.
funnel.bySource.jotform.labels.push("(No application on file)", "(Application left blank)");
funnel.bySource.jotform.contacts["(No application on file)"] = spread(64, [1, .9, .8]);
funnel.bySource.jotform.contacts["(Application left blank)"] = spread(2, [1, 1, 1]);
for (const k of ["opportunities", "totalSales"]) {
  funnel.bySource.jotform[k]["(No application on file)"] = spread(0, [0]);
  funnel.bySource.jotform[k]["(Application left blank)"] = spread(0, [0]);
}

const CHANNELS = [
  "Paid Search", "Paid Social", "Organic Search", "Organic Social", "Email Marketing",
  "Direct Traffic", "Referrals", "Other Campaigns", "Offline Sources", "AI Referrals",
];
const spendZero = () => MONTHS.map(() => 0);
const spend = {
  months: MONTHS,
  channels: CHANNELS,
  spend: Object.fromEntries(CHANNELS.map((c) => [c, spendZero()])),
  rows: [],
  generatedAt: new Date().toISOString(),
};
// Real audited figures for Jun/Jul 2026 (indices 9 and 10).
spend.spend["Paid Search"][9] = 1570.44;
spend.spend["Paid Search"][10] = 1574.16;
spend.spend["Paid Social"][9] = 417.80;
spend.spend["Paid Social"][10] = 425.18;
spend.rows = [
  { month: "2026-06", channel: "Paid Search", amount: 1570.44, currency: "NZD", fxToNzd: 1, amountNzd: 1570.44, note: null },
  { month: "2026-07", channel: "Paid Search", amount: 1574.16, currency: "NZD", fxToNzd: 1, amountNzd: 1574.16, note: null },
  { month: "2026-06", channel: "Paid Social", amount: 238.74, currency: "USD", fxToNzd: 1.75, amountNzd: 417.80, note: null },
  { month: "2026-07", channel: "Paid Social", amount: 242.96, currency: "USD", fxToNzd: 1.75, amountNzd: 425.18, note: null },
];

const failures = [];
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
}

// CHROMIUM_PATH lets a sandbox with a pre-installed browser skip
// `npx playwright install`. Unset locally, Playwright uses its own download.
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

// Sandboxed CI often can't reach a CDN from inside the browser even when the
// host can. Proxy Chart.js through Node so the real chart code paths still
// run; if the host can't reach it either, the page's no-charts fallback takes
// over and the table assertions below still stand.
let chartJs = null;
try {
  const r = await fetch("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js");
  if (r.ok) chartJs = await r.text();
} catch { /* offline; fallback path gets exercised instead */ }
if (chartJs) {
  await page.route("**/chart.umd.min.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: chartJs }));
}
// Google Fonts is decorative here — stub it so a blocked font host doesn't
// stall `load` and slow every run.
await page.route("**/fonts.googleapis.com/**", (route) =>
  route.fulfill({ status: 200, contentType: "text/css", body: "" }));

await page.route("**/api/sales-funnel-data*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(funnel) }));
await page.route("**/api/marketing-spend*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(spend) }));

console.log("\nmarketing-performance smoke\n");

await page.goto(pageUrl, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelectorAll("#kpis .kpi").length > 0, { timeout: 15000 });
await page.waitForTimeout(600);

// --- structure
check("no page errors", consoleErrors.length === 0, consoleErrors.join(" | "));
check("error banner hidden", await page.locator("#error-banner").isHidden());
check("6 KPI tiles", (await page.locator("#kpis .kpi").count()) === 6);
check("back button present", (await page.locator('a[href="/"]').count()) >= 1);

// --- the join that this dashboard exists for
const spendKpi = await page.locator("#kpis .kpi").first().locator(".value").innerText();
check("total spend KPI computed", spendKpi.includes("3,988") || spendKpi.includes("3,987"), `got "${spendKpi}"`);

const costRows = await page.locator("#cost-table tbody tr").count();
check("cost table has rows", costRows > 1, `rows=${costRows}`);

const costText = await page.locator("#cost-table").innerText();
check("cost/lead rendered for Paid Search", /Paid Search/.test(costText));
check("unmeasured channels show em dash not $0", costText.includes("—"));

// --- attribution: two independent taxonomies, both rendered
const chartsAvailable = await page.evaluate(() => typeof window.Chart !== "undefined");
if (chartsAvailable) {
  // Chart.getChart() is the public v4 registry lookup. The page keeps its
  // instances in a script-scoped `let`, which page.evaluate can't see.
  const drawn = await page.evaluate(() => ({
    hs: !!window.Chart.getChart("chart-hs"),
    jf: !!window.Chart.getChart("chart-jf"),
    trend: !!window.Chart.getChart("chart-trend"),
    hsBars: window.Chart.getChart("chart-hs")?.data?.datasets?.[0]?.data?.length || 0,
    jfBars: window.Chart.getChart("chart-jf")?.data?.datasets?.[0]?.data?.length || 0,
  }));
  check("hubspot attribution chart drawn", drawn.hs);
  check("jotform attribution chart drawn", drawn.jf);
  check("trend chart drawn", drawn.trend);
  check("both taxonomies plotted independently", drawn.hsBars > 0 && drawn.jfBars > 0,
    `hs=${drawn.hsBars} jf=${drawn.jfBars}`);

  // --- the (Unknown) regression: the never-asked bucket must not be a bar
  const jfLabels = await page.evaluate(() =>
    window.Chart.getChart("chart-jf")?.data?.labels || []);
  check("jotform chart excludes the never-asked bucket",
    !jfLabels.includes("(No application on file)"), jfLabels.join("|"));
  check("jotform chart keeps genuinely blank answers visible",
    jfLabels.includes("(Application left blank)"), jfLabels.join("|"));
  check("jotform chart is led by a real answer, not a placeholder",
    jfLabels[0] === "Social Media", `top=${jfLabels[0]}`);

  // --- metric switch: the whole point is that the ranking changes
  const byLeads = await page.evaluate(() => window.Chart.getChart("chart-jf").data.labels);
  await page.locator('.metric-switch[data-panel="jf"] button[data-metric="totalSales"]').click();
  await page.waitForTimeout(200);
  const bySales = await page.evaluate(() => ({
    labels: window.Chart.getChart("chart-jf").data.labels,
    data: window.Chart.getChart("chart-jf").data.datasets[0].data,
    colour: window.Chart.getChart("chart-jf").data.datasets[0].backgroundColor,
    legend: window.Chart.getChart("chart-jf").data.datasets[0].label,
  }));
  check("switching to Sales re-ranks the chart",
    bySales.labels.join("|") !== byLeads.join("|"), `leads=${byLeads[0]} sales=${bySales.labels[0]}`);
  check("Sales ranking is actually sorted by sales",
    bySales.data.every((v, i, a) => i === 0 || a[i - 1] >= v), bySales.data.join(","));
  check("Sales view is colour-coded distinctly", bySales.colour === "#81C243", String(bySales.colour));
  check("chart legend names the active metric", bySales.legend === "Sales", String(bySales.legend));
  check("sources with leads but no sales drop out of the Sales chart",
    !bySales.labels.includes("Go Abroad"), bySales.labels.join("|"));

  // The table keeps all three stages regardless of what the chart shows.
  const jfTableSales = await page.locator("#jf-table").innerText();
  check("table still shows every stage under the Sales view",
    /Leads[\s\S]*Opps[\s\S]*Sales/i.test(jfTableSales));
  check("table reorders with the chart",
    jfTableSales.indexOf("Word of Mouth") < jfTableSales.indexOf("Go Abroad"), jfTableSales.slice(0, 120));

  // Each panel switches on its own — the usual question puts them on
  // different metrics ("brings leads, but does it bring sales?").
  const hsStillLeads = await page.evaluate(() =>
    window.Chart.getChart("chart-hs").data.datasets[0].label);
  check("the two panels switch independently", hsStillLeads === "Leads", String(hsStillLeads));

  await page.locator('.metric-switch[data-panel="jf"] button[data-metric="contacts"]').click();
  await page.waitForTimeout(200);
  check("switching back restores the lead ranking",
    (await page.evaluate(() => window.Chart.getChart("chart-jf").data.labels)).join("|") === byLeads.join("|"));

  // --- by-month view: the spreadsheet layout
  await page.locator('.view-switch[data-panel="jf"] button[data-view="month"]').click();
  await page.waitForTimeout(250);
  const stacked = await page.evaluate(() => {
    const c = window.Chart.getChart("chart-jf");
    return {
      labels: c.data.labels,
      series: c.data.datasets.map((d) => d.label),
      stackedX: c.options.scales.x.stacked === true,
      stackedY: c.options.scales.y.stacked === true,
      firstRow: c.data.datasets[0].data.length,
    };
  });
  check("month view puts months on the x axis", stacked.labels.length === 12, `n=${stacked.labels.length}`);
  check("month view labels months, not sources", /^[A-Z][a-z]{2,4} \d{2}$/.test(stacked.labels[0]), stacked.labels[0]);
  check("month view stacks the sources", stacked.stackedX && stacked.stackedY);
  check("each series spans every month", stacked.firstRow === 12, `len=${stacked.firstRow}`);
  check("long tail is pooled, not rendered as hairlines",
    stacked.series.length <= 7, `series=${stacked.series.length}`);
  check("the pooled series says how many it covers",
    stacked.series.some((s) => /^Other sources \(\d+\)$/.test(s)), stacked.series.join("|"));

  const matrixHead = await page.locator("#jf-table thead").innerText();
  check("matrix header is months", (matrixHead.match(/\b[A-Z]{3,4} \d{2}\b/g) || []).length === 12, matrixHead);
  check("matrix keeps a Source column and a Total column",
    /SOURCE/i.test(matrixHead) && /TOTAL/i.test(matrixHead), matrixHead);
  const stickies = await page.locator("#jf-table td.sticky").count();
  check("source name is pinned while the year scrolls", stickies > 1, `sticky=${stickies}`);
  check("empty months read as a dash, not a zero",
    (await page.locator("#jf-table td.zero").count()) > 0);

  // Row totals in the matrix must agree with the totals view, or one of the
  // two is lying.
  const womRow = await page.locator('#jf-table tbody tr', { hasText: 'Word of Mouth' }).first().innerText();
  const womTotal = womRow.trim().split(/\s+/).pop();
  check("matrix row total matches the totals view", womTotal === "32", `got ${womTotal}`);

  check("card widens so a year of columns is readable",
    await page.locator('#jf-table').evaluate((t) => t.closest('.card').classList.contains('wide')));

  await page.locator('.view-switch[data-panel="jf"] button[data-view="total"]').click();
  await page.waitForTimeout(250);
  check("leaving month view restores the ranked bars",
    (await page.evaluate(() => window.Chart.getChart("chart-jf").data.datasets.length)) === 1);
  check("card gives the row back",
    !(await page.locator('#jf-table').evaluate((t) => t.closest('.card').classList.contains('wide'))));
  check("totals table returns", /Leads[\s\S]*Opps[\s\S]*Sales/i.test(await page.locator("#jf-table").innerText()));

  // --- offline breakout
  const off = await page.evaluate(() => {
    const c = window.Chart.getChart("chart-offline");
    return { labels: c?.data?.labels || [], data: c?.data?.datasets?.[0]?.data || [],
             colors: c?.data?.datasets?.[0]?.backgroundColor || [] };
  });
  check("offline breakout chart drawn", off.labels.length > 0);
  check("offline split is ranked by volume",
    off.data.slice(0, -1).every((v, i, a) => i === 0 || a[i - 1] >= v), off.data.join(","));
  check("unrecovered remainder is last, not hidden",
    off.labels[off.labels.length - 1] === "Not recoverable");
  check("unrecovered remainder is greyed out",
    off.colors[off.colors.length - 1] === "#4a5560", String(off.colors[off.colors.length - 1]));
} else {
  console.log("  · Chart.js unreachable — asserting the no-charts fallback instead");
  check("degrades without charts, tables still render",
    (await page.locator("#cost-table tbody tr").count()) > 1);
  check("tells the reader charts are missing",
    (await page.locator("#traffic-notice").innerText()).includes("Charts unavailable"));
  check("offline table renders without charts",
    (await page.locator("#offline-table tbody tr").count()) > 1);
}

// --- offline breakout: the numbers and the honesty, chart or no chart
const offHead = await page.locator("#offline-head").innerText();
check("offline header states the Offline volume", /648\s*Offline leads/.test(offHead.replace(/,/g, "")), offHead);
check("offline header states recovery as a share", /%/.test(offHead), offHead);
check("offline header names the unreadable remainder", /no drill-down/i.test(offHead), offHead);

const offRows = await page.locator("#offline-table tbody tr").count();
check("offline detail table lists the recovered sources", offRows > 1, `rows=${offRows}`);
const offText = await page.locator("#offline-table").innerText();
check("offline table surfaces the referring domain", offText.includes("gooverseas.com"));
check("offline table surfaces the ad campaign", offText.includes("Performance Max - Europe"));
check("offline table carries the unrecovered row", /No drill-down recorded/.test(offText));
check("offline table joins leads to opps and sales",
  /Leads[\s\S]*Opps[\s\S]*Sales/i.test(offText), offText.slice(0, 80));

// A utm_source is attacker-controlled free text and lands in this table.
const injected = await page.evaluate(() =>
  document.querySelectorAll("#offline-table script").length);
check("drill-down values are escaped, not executed", injected === 0);
check("the escaped value is still shown as text",
  offText.includes("<script>x</script>"));

// --- attribution tables: the funnel per source, chart or no chart
const jfTable = await page.locator("#jf-table").innerText();
check("self-reported table carries leads, opps and sales",
  /Leads[\s\S]*Opps[\s\S]*Sales/i.test(jfTable));
check("self-reported table totals its columns", /Total/.test(jfTable));
check("self-reported table excludes the never-asked bucket",
  !jfTable.includes("No application on file"), jfTable.slice(0, 200));
check("cookie table renders too",
  (await page.locator("#hs-table tbody tr").count()) > 1);

// A source that produced sales this window must show them, or the panel
// cannot answer "which of these turned into sales".
check("a converting source shows a non-zero sales figure",
  /Word of Mouth\s+\d+\s+\d+\s+[1-9]/.test(jfTable), jfTable.slice(0, 300));

// --- the cohort caveat must be stated, not implied
const foot = await page.locator(".footnote").innerText();
check("page warns leads and sales are not a cohort", /not a cohort/i.test(foot));
check("page declines to present a conversion rate", /conversion rate and isn't one/i.test(foot));

// --- self-reported coverage: the denominator that makes the panel readable
const cov = await page.locator("#jf-coverage").innerText();
check("coverage line states how many answered", /\d+ answers/.test(cov), cov);
check("coverage line states who was never asked", /never (reached|asked)/i.test(cov), cov);
check("coverage line warns against reading it as a share of all leads",
  /not as a share of all leads/i.test(cov), cov);

// --- spend editor
const cells = await page.locator("#spend-table input.cell").count();
check("spend grid rendered (12 months x 4 channels)", cells === 48, `cells=${cells}`);
check("save disabled with no edits", await page.locator("#save-spend").isDisabled());

// FX seeded from the stored USD rows, not from a hardcoded guess.
check("FX rate seeded from stored rows", (await page.locator("#fx-rate").inputValue()) === "1.75");
check("Paid Social column defaults to USD",
  (await page.locator('select[data-cur-for="Paid Social"]').inputValue()) === "USD");
check("Paid Search column defaults to NZD",
  (await page.locator('select[data-cur-for="Paid Search"]').inputValue()) === "NZD");

// Clearing the rate must block a USD save rather than writing a zeroed NZD figure.
await page.locator('#spend-table input.cell[data-channel="Paid Social"]').first().fill("500");
await page.locator("#fx-rate").fill("");
await page.waitForTimeout(150);
check("USD save blocked with no rate", await page.locator("#save-spend").isDisabled());
check("save note explains why", (await page.locator("#save-note").innerText()).includes("USD"));
await page.locator("#fx-rate").fill("1.68");
await page.waitForTimeout(150);
check("save unblocks once a rate is entered", !(await page.locator("#save-spend").isDisabled()));

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#kpis .kpi").length > 0, { timeout: 15000 });
await page.waitForTimeout(300);
await page.locator("#spend-table input.cell").first().fill("1234");
await page.waitForTimeout(150);
check("save enables after an edit", !(await page.locator("#save-spend").isDisabled()));
check("edited cell marked dirty", (await page.locator("#spend-table input.cell.dirty").count()) === 1);

// --- no horizontal overflow at desktop width
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("no horizontal page overflow", overflow <= 1, `overflow=${overflow}px`);

// ---------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------
console.log("\n  comparison mode:\n");
await page.locator("#compare-on").check();
await page.waitForFunction(() => document.querySelectorAll("#kpis .kpi .delta").length > 0, { timeout: 15000 });
await page.waitForTimeout(400);

check("cmp: comparison range revealed", await page.locator("#from-b").isVisible());
check("cmp: YoY preset active by default", await page.locator("#cmp-yoy").evaluate((e) => e.classList.contains("active")));

// Range A is Sep 25 – Aug 26; YoY must be exactly twelve months earlier.
const [fB, tB] = [await page.locator("#from-b").inputValue(), await page.locator("#to-b").inputValue()];
check("cmp: YoY range is A minus 12 months", fB === "2024-09" && tB === "2025-08", `${fB}..${tB}`);

// Previous period must be the same LENGTH as A, immediately before it.
await page.locator("#cmp-prev").click();
await page.waitForTimeout(600);
const [pF, pT] = [await page.locator("#from-b").inputValue(), await page.locator("#to-b").inputValue()];
check("cmp: previous period is same length, immediately prior", pF === "2024-09" && pT === "2025-08", `${pF}..${pT}`);

await page.locator("#cmp-yoy").click();
await page.waitForTimeout(600);

check("cmp: every KPI carries a delta", (await page.locator("#kpis .kpi .delta").count()) === 6);
check("cmp: prior values shown", (await page.locator("#kpis .prev-val").count()) >= 5);
check("cmp: header names both periods", (await page.locator("#generated").innerText()).includes(" vs "));
check("cmp: cost table gained comparison columns",
  (await page.locator("#cost-table thead th.cmp").count()) === 2);
const trendDatasets = await page.evaluate(() => window.Chart?.getChart("chart-trend")?.data?.datasets?.length || 0);
check("cmp: trend chart gained prior series", trendDatasets === 6, `datasets=${trendDatasets}`);

await page.screenshot({ path: join(here, "..", "marketing-performance-compare.png"), fullPage: true });

// Identical periods must read as flat, not as a spurious move.
await page.locator("#from-b").fill(await page.locator("#from").inputValue());
await page.locator("#to-b").fill(await page.locator("#to").inputValue());
await page.locator("#refresh").click();
await page.waitForTimeout(1200);
const flats = await page.locator("#kpis .kpi .delta.flat").count();
check("cmp: comparing a period to itself reads flat", flats >= 4, `flat badges=${flats}`);

await page.locator("#compare-on").uncheck();
await page.waitForTimeout(1200);
check("cmp: unchecking removes deltas", (await page.locator("#kpis .kpi .delta").count()) === 0);
check("cmp: unchecking restores single-period table",
  (await page.locator("#cost-table thead th.cmp").count()) === 0);

await page.screenshot({ path: join(here, "..", "marketing-performance-preview.png"), fullPage: true });
console.log("\n  screenshot → marketing-performance-preview.png");

// One more with the spreadsheet view open, since that layout is the thing
// most likely to break silently on a CSS change.
await page.locator('.view-switch[data-panel="jf"] button[data-view="month"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: join(here, "..", "marketing-performance-bymonth.png"), fullPage: true });
console.log("  screenshot → marketing-performance-bymonth.png");
await page.locator('.view-switch[data-panel="jf"] button[data-view="total"]').click();
await page.waitForTimeout(250);

// ---------------------------------------------------------------
// Degradation: the spend table missing must NOT take the page down.
// This reproduces the exact 500 seen before MIGRATION-marketing-spend.sql
// has been run.
// ---------------------------------------------------------------
console.log("\n  degraded run — spend endpoint 500s:\n");
const page2 = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs2 = [];
page2.on("pageerror", (e) => errs2.push(String(e)));
if (chartJs) {
  await page2.route("**/chart.umd.min.js", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: chartJs }));
}
await page2.route("**/fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
await page2.route("**/api/sales-funnel-data*", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(funnel) }));
await page2.route("**/api/marketing-spend*", (r) =>
  r.fulfill({ status: 500, contentType: "application/json",
              body: JSON.stringify({ error: 'relation "marketing_spend" does not exist' }) }));

await page2.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page2.waitForFunction(() => document.querySelectorAll("#kpis .kpi").length > 0, { timeout: 15000 });
await page2.waitForTimeout(400);

check("degraded: no page errors", errs2.length === 0, errs2.join(" | "));
check("degraded: fatal error banner NOT shown", await page2.locator("#error-banner").isHidden());
check("degraded: funnel KPIs still render", (await page2.locator("#kpis .kpi").count()) === 6);
check("degraded: cost table still lists channels", (await page2.locator("#cost-table tbody tr").count()) > 1);
const notice2 = await page2.locator("#traffic-notice").innerText();
check("degraded: explains the missing table", /marketing_spend/.test(notice2), notice2.slice(0, 120));
check("degraded: names the migration to run", /MIGRATION-marketing-spend\.sql/.test(notice2));
check("degraded: spend inputs disabled", await page2.locator("#spend-table input.cell").first().isDisabled());
await page2.close();

// --- stale-function run: the page ships, the function hasn't been redeployed
// yet, so the payload has no `offline` / `applications` keys. The new panels
// should say so and everything else should carry on, rather than the page
// dying on a property read.
console.log("\n  stale-function run — funnel payload predates the offline breakout:\n");
const page3 = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs3 = [];
page3.on("pageerror", (e) => errs3.push(String(e)));
if (chartJs) {
  await page3.route("**/chart.umd.min.js", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: chartJs }));
}
await page3.route("**/fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
await page3.route("**/api/sales-funnel-data*", (r) => {
  const { offline, applications, ...old } = funnel;
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(old) });
});
await page3.route("**/api/marketing-spend*", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(spend) }));
await page3.goto(pageUrl, { waitUntil: "domcontentloaded" });
await page3.waitForFunction(() => document.querySelectorAll("#kpis .kpi").length > 0, { timeout: 15000 });
await page3.waitForTimeout(400);

check("stale: no page errors", errs3.length === 0, errs3.join(" | "));
check("stale: funnel KPIs still render", (await page3.locator("#kpis .kpi").count()) === 6);
check("stale: offline panel says it is unavailable",
  /unavailable/i.test(await page3.locator("#offline-head").innerText()));
check("stale: jotform panel falls back rather than lying",
  (await page3.locator("#jf-coverage").innerText()).length > 0);
await page3.close();

await browser.close();
server.close();

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(", ")}\n` : "\nAll checks passed.\n");
process.exit(failures.length ? 1 : 0);
