// netlify/functions/_shared/cash-opex.mjs
//
// Monthly operating expenses from the Xero P&L.
//
// WHY THIS EXISTS
// ---------------
// The Overheads row is twelve numbers typed once a year, carried over from the
// workbook, and nothing refreshes them. Five months of real data sitting in Xero
// showed the annual total is close (about 3% light) but the MONTHLY SHAPE is
// badly wrong — May overstated by 22,080, June understated by 38,951. A cash
// forecast lives or dies on which month money leaves, so a right-in-total,
// wrong-by-month row is exactly the failure that matters.
//
// NON-CASH LINES ARE EXCLUDED, AND THAT IS THE WHOLE SUBTLETY
// -----------------------------------------------------------
// A P&L operating-expense section is accrual and contains lines that never move
// cash. Pacific Discovery's carries two large ones — Bank Revaluations and
// Unrealised Currency Gains — which swing by tens of thousands a month in both
// directions as the USD balance is remeasured. Feeding those into a cash
// forecast imports pure noise: June's raw opex looks 33,805 cheaper than it was,
// purely because the dollar moved.
//
// Comparing raw P&L opex against the model overstated the error at 7.4%. Against
// cash-like opex it is 2.9%. The exclusions are named below rather than inferred,
// so anyone can see and change what was left out.
//
// READ-ONLY. Every request here is a GET.

import { xeroGet } from "./cash-xero.mjs";
import { monthRange } from "./cash-xero.mjs";

/**
 * Account names excluded from the cash view of operating expenses.
 *
 * Matched case-insensitively against the whole line name. Deliberately a short,
 * explicit list rather than a clever rule: an over-eager pattern that silently
 * dropped "Bank Fees" (real cash, 6,454 a year) would be invisible.
 */
export const NON_CASH_LINES = [
  /^bank revaluations?$/i,
  /^unrealised (currency|foreign exchange|fx) (gains?|losses?)$/i,
  /^depreciation$/i,
  /^amortisation$/i,
];

export function isNonCash(name, patterns = NON_CASH_LINES) {
  const n = String(name ?? "").trim();
  return patterns.some((p) => p.test(n));
}

/** Xero renders negatives in parentheses in some report cells. */
function cellValue(cell) {
  const raw = cell?.Value;
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(String(raw).replace(/[(),$\s]/g, ""));
  if (Number.isNaN(n)) return 0;
  return /^\(.*\)$/.test(String(raw)) ? -n : n;
}

/**
 * Pull the Operating Expenses section out of a P&L report.
 *
 * Sections are matched by title rather than position — a chart of accounts with
 * no cost-of-sales section would shift every index. Rows nest to varying depth,
 * so leaves are collected recursively, and SummaryRow totals are skipped so
 * nothing is counted twice.
 *
 * @returns {{lines: Array<{name, amount, nonCash}>, total, cashTotal, excluded, sectionFound}}
 */
export function parseOperatingExpenses(report, patterns = NON_CASH_LINES) {
  const sections = report?.Reports?.[0]?.Rows ?? [];
  // Every section title, so "the numbers are too small" can be answered by
  // looking rather than guessing. A custom layout shows up here immediately as
  // headings that are not the four standard ones.
  const sectionsSeen = sections
    .filter((s) => s.RowType === "Section")
    .map((s) => ({ title: s.Title || "(untitled)", rows: (s.Rows ?? []).length }));

  const section = sections.find(
    (s) => s.RowType === "Section" && /operating expense/i.test(s.Title ?? ""),
  );
  if (!section) {
    return { lines: [], total: 0, cashTotal: 0, excluded: [], sectionFound: false, sectionsSeen };
  }

  const lines = [];
  (function walk(rows) {
    for (const row of rows ?? []) {
      if (row.Rows) walk(row.Rows);
      // SummaryRow is the section's own total — including it would double.
      if (row.RowType !== "Row") continue;
      const name = row.Cells?.[0]?.Value;
      if (!name) continue;
      const amount = cellValue(row.Cells?.[1]);
      lines.push({ name, amount, nonCash: isNonCash(name, patterns) });
    }
  })(section.Rows);

  const total = lines.reduce((s, l) => s + l.amount, 0);
  const excluded = lines.filter((l) => l.nonCash);
  const cashTotal = total - excluded.reduce((s, l) => s + l.amount, 0);

  return { lines, total, cashTotal, excluded, sectionFound: true, sectionsSeen };
}

/**
 * Operating expenses for one month, cash view.
 *
 * One P&L call per month. Cached by the caller the same way bank months are, so
 * a closed month is fetched once and never again.
 */
export async function fetchMonthOpex(accessToken, tenantId, key, patterns = NON_CASH_LINES) {
  const { from, to } = monthRange(key);
  const report = await xeroGet(accessToken, tenantId, "Reports/ProfitAndLoss", {
    fromDate: from,
    toDate: to,
    // Without this, Xero renders the organisation's own custom P&L layout —
    // which can group accounts under headings of its own and leave the section
    // called "Operating Expenses" holding only part of the expenses. That is
    // the shape of the bug this fixes: April read 18,657 against a real 94,093,
    // May read 131, and no two months were wrong by the same ratio, which is
    // what a subset looks like rather than a scaling error.
    standardLayout: "true",
  });
  const parsed = parseOperatingExpenses(report, patterns);

  return {
    month: key,
    total: parsed.total,
    cashTotal: parsed.cashTotal,
    sectionFound: parsed.sectionFound,
    sectionsSeen: parsed.sectionsSeen,
    lineCount: parsed.lines.length,
    excluded: parsed.excluded.map((l) => ({ name: l.name, amount: l.amount })),
    // Biggest lines first, so a wrong figure has an obvious place to start.
    topLines: parsed.lines
      .filter((l) => !l.nonCash)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 12)
      .map((l) => ({ name: l.name, amount: Math.round(l.amount) })),
    source: "Xero Profit and Loss",
    fetchedAt: new Date().toISOString(),
  };
}

export default { parseOperatingExpenses, fetchMonthOpex, isNonCash, NON_CASH_LINES };
