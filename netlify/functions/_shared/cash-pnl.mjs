// netlify/functions/_shared/cash-pnl.mjs
//
// The profit and loss, in full, with every line you can open.
//
// WHY THIS EXISTS
// ---------------
// The Surplus tab answers one question well — are we going to make the year's
// budget — and it answers it with three rows. Revenue, cost of sales,
// overheads. Three numbers is the right size for a verdict and the wrong size
// for a diagnosis: "cost of sales is 266,000 over" is where the conversation
// starts, not where it ends, and the page had nothing underneath it.
//
// Everything needed was already in the store. Every closed month's P&L fetch
// keeps its operating-expense lines, and from parser version 7 its income and
// cost-of-sales lines too. This assembles them into the statement itself.
//
// THIS IS THE P&L, AND THAT IS NOT THE BANK
// -----------------------------------------
// Revenue counts in the month it is RECOGNISED — a whole season at once, the
// month it departs — not when the students' money arrived. Cost of sales is a
// supplier bill on the day it is raised, not the day it is paid. Nothing in
// here will agree with the Cash flow tab, and the gap between them is deferred
// revenue, which on these books runs to seven figures. Any caller that adds a
// figure from this module to a figure from the cash forecast has produced a
// number that means nothing.
//
// THE COMPARISON THAT IS EASY TO GET WRONG
// ----------------------------------------
// Five months of trading against twelve months of budget reads as a
// spectacular underspend on every single row. So the budget is cut to the same
// months as the actuals — `budgetToDate` — and the full-year budget is kept in
// its own clearly separate column. Both are here; only one of them is a
// comparison.
//
// Pure — no I/O — so it runs against fixtures.

/** Variance stated so that POSITIVE IS GOOD NEWS on every row.
 *
 * Revenue above budget is positive. Costs BELOW budget are also positive. The
 * alternative — a raw actual-minus-budget everywhere — means the reader has to
 * remember which rows invert, and the surplus variance then fails to be the sum
 * of the three rows above it, which is the check that catches a flipped sign.
 */
const favourable = (actual, budget, sign) => (sign > 0 ? actual - budget : budget - actual);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (n) => Math.round(n);
const sum = (a) => a.reduce((s, v) => s + v, 0);

/** Twelve "YYYY-MM" keys, April first. */
export function fiscalKeys(fyStartYear) {
  return Array.from({ length: 12 }, (_, i) => {
    const abs = 3 + i;
    const y = fyStartYear + Math.floor(abs / 12);
    return `${y}-${String((abs % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * Match a reported P&L line to a budgeted account.
 *
 * The two come from different places and are spelled differently. A budget line
 * is identified by AccountID and labelled "420 Rent"; the P&L prints "Rent",
 * or "420 Rent" depending on the organisation's report settings. Matching on
 * the raw string therefore fails on roughly half of a real chart of accounts —
 * and it fails SILENTLY, as "no budget for this line", which reads on screen
 * as an unbudgeted overspend rather than as a matching bug.
 *
 * So: strip a leading account code, collapse whitespace, lowercase. Nothing
 * cleverer. A fuzzy match here would eventually pair "Travel" with "Travel
 * Insurance" and put the variance on the wrong row, which is worse than no
 * match at all because it looks right.
 */
export function normaliseAccount(name) {
  return String(name ?? "")
    .replace(/^\s*\d{2,6}\s*[-–—:.]?\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * One section of the statement — its lines, its months, and its budget.
 *
 * @param opts.records      stored opex records for the closed months, in order
 * @param opts.pick         record -> the section's lines for that month
 * @param opts.pickTotal    record -> the section's total for that month, which
 *                          is taken from the record's own total rather than
 *                          summed from the lines. See `residual` below.
 * @param opts.budgetLines  budgeted accounts: [{name, code, months[12], amount}]
 * @param opts.sign         +1 for income, -1 for a cost
 * @param opts.slotOf       month key -> 0-11
 * @param opts.closedSlots  the slots that have a stored record
 */
function buildSection({
  id, title, sign, records, pick, pickTotal, budgetLines = [],
  slotOf, closedSlots, note = null, truncatedWhen = () => false,
}) {
  const monthsActual = Array(12).fill(0);
  const byName = new Map();
  const truncatedMonths = [];

  for (const rec of records) {
    const slot = slotOf(rec.month);
    if (slot === null) continue;
    monthsActual[slot] += num(pickTotal(rec));
    if (truncatedWhen(rec)) truncatedMonths.push(rec.month);

    for (const line of pick(rec) ?? []) {
      const name = String(line?.name ?? "").trim();
      if (!name) continue;
      if (!byName.has(name)) {
        byName.set(name, { name, months: Array(12).fill(0), nonCash: Boolean(line.nonCash) });
      }
      // += rather than =, because a P&L can carry the same account name twice
      // under different parents and a recursive walk collects both leaves.
      byName.get(name).months[slot] += num(line.amount);
    }
  }

  // Budget accounts indexed by normalised name, so a reported line can find
  // its plan. Several budget accounts can normalise to the same name — rare,
  // but it happens with an archived duplicate — so they are summed rather than
  // one of them silently winning.
  const budgetByKey = new Map();
  for (const b of budgetLines) {
    const key = normaliseAccount(b.name ?? b.account);
    if (!key) continue;
    if (!budgetByKey.has(key)) {
      budgetByKey.set(key, { key, label: b.account ?? b.name, months: Array(12).fill(0), used: false });
    }
    const e = budgetByKey.get(key);
    (b.months ?? Array(12).fill(0)).forEach((v, i) => { e.months[i] += num(v); });
  }

  const budgetMonths = Array(12).fill(0);
  for (const b of budgetByKey.values()) b.months.forEach((v, i) => { budgetMonths[i] += v; });

  const toDate = (months) => sum(closedSlots.map((s) => months[s]));

  const lines = [...byName.values()].map((l) => {
    const key = normaliseAccount(l.name);
    const b = budgetByKey.get(key) ?? null;
    if (b) b.used = true;
    const bMonths = b ? b.months : Array(12).fill(0);
    const actualToDate = toDate(l.months);
    const budgetToDateV = b ? toDate(bMonths) : null;
    return {
      name: l.name,
      nonCash: l.nonCash,
      months: l.months.map(round),
      total: round(actualToDate),
      budgetMonths: b ? bMonths.map(round) : null,
      budgetTotal: b ? round(sum(bMonths)) : null,
      budgetToDate: b ? round(budgetToDateV) : null,
      varianceToDate: b ? round(favourable(actualToDate, budgetToDateV, sign)) : null,
      /* WHY A LINE HAS NO BUDGET, STATED RATHER THAN LEFT BLANK.
       *
       *   matched     it is in the budget, and the variance means something
       *   nonCash     a revaluation or depreciation. The budget deliberately
       *               excludes these (see classifyLine), so an empty budget
       *               cell here is correct and a variance would be nonsense.
       *   unbudgeted  it is being spent and it is not in the plan. That is a
       *               real finding, and the one this flag exists to surface. */
      budgetStatus: b ? "matched" : l.nonCash ? "nonCash" : "unbudgeted",
    };
  }).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  /* BUDGETED AND NOT SPENT IS NOT THE SAME AS NOT BUDGETED.
   *
   * An account with a plan and no actual line produces no row above, because
   * the rows come from what the books reported. Dropping it would understate
   * the budget column against its own lines and hide a saving. These are
   * listed separately rather than mixed in as zero-actual rows, because a
   * statement full of accounts nobody spent anything on is unreadable. */
  const budgetOnly = [...budgetByKey.values()]
    .filter((b) => !b.used && Math.abs(sum(b.months)) > 0.5)
    .map((b) => ({
      name: b.label,
      budgetTotal: round(sum(b.months)),
      budgetToDate: round(toDate(b.months)),
      budgetMonths: b.months.map(round),
    }))
    .sort((a, b) => Math.abs(b.budgetTotal) - Math.abs(a.budgetTotal));

  /* THE LINES MUST ADD UP TO THE TOTAL, AND WHEN THEY DO NOT, SAY SO.
   *
   * The section total comes from the record's own stored total, not from
   * summing the lines — deliberately, because the two can differ: a record
   * written before parser version 7 has the total and no lines at all, and one
   * written before version 5 has the twelve biggest expense lines only. A
   * drill-down whose parts quietly fail to reconstruct the whole is worse than
   * one that admits the gap, because the reader has no way to detect it.
   *
   * So the residual is computed and, where it matters, shown as its own row. */
  const lineMonths = Array(12).fill(0);
  for (const l of lines) l.months.forEach((v, i) => { lineMonths[i] += v; });
  const residualMonths = monthsActual.map((v, i) => v - lineMonths[i]);
  const residualToDate = toDate(residualMonths);

  const actualToDate = toDate(monthsActual);
  const budgetToDateTotal = toDate(budgetMonths);

  return {
    id,
    title,
    sign,
    note,
    months: monthsActual.map(round),
    total: round(actualToDate),
    budgetMonths: budgetMonths.map(round),
    budgetTotal: round(sum(budgetMonths)),
    budgetToDate: round(budgetToDateTotal),
    varianceToDate: round(favourable(actualToDate, budgetToDateTotal, sign)),
    lines,
    budgetOnly,
    truncatedMonths,
    residual: {
      months: residualMonths.map(round),
      total: round(residualToDate),
      // Under a dollar a month across the closed months is rounding, not a
      // missing line. Above that the drill-down is genuinely incomplete.
      material: Math.abs(residualToDate) > Math.max(1, closedSlots.length),
    },
    nonCashTotal: round(sum(lines.filter((l) => l.nonCash).map((l) => l.total))),
    unbudgetedTotal: round(sum(lines.filter((l) => l.budgetStatus === "unbudgeted").map((l) => l.total))),
  };
}

/**
 * Budget accounts from an older store, which kept an annual total per account
 * and no monthly split.
 *
 * The budget-to-date column needs months. Given only a year, the least-wrong
 * thing is an even twelfth — and the honest thing is to say so, which the
 * caller does in a warning rather than letting an evenly-spread figure pass as
 * a real monthly plan. The alternative, treating the line as unbudgeted, is
 * worse: it turns every overhead account into an apparent overspend until the
 * next refresh.
 */
function spreadEvenly(lines) {
  return lines.map((b) => (Array.isArray(b.months) ? b : {
    ...b,
    months: Array(12).fill(num(b.amount) / 12),
    spread: true,
  }));
}

/** A derived row — gross profit, surplus — with the same shape as a section. */
function derived(id, title, parts, closedSlots) {
  const months = Array(12).fill(0);
  const budgetMonths = Array(12).fill(0);
  for (const { section, sign } of parts) {
    section.months.forEach((v, i) => { months[i] += sign * v; });
    section.budgetMonths.forEach((v, i) => { budgetMonths[i] += sign * v; });
  }
  const toDate = (m) => sum(closedSlots.map((s) => m[s]));
  const a = toDate(months);
  const b = toDate(budgetMonths);
  return {
    id, title,
    months: months.map(round),
    total: round(a),
    budgetMonths: budgetMonths.map(round),
    budgetTotal: round(sum(budgetMonths)),
    budgetToDate: round(b),
    // A surplus behaves like income: more is better. So the plain difference
    // is already the favourable direction, and the three sections' variances
    // add to this one — which is the arithmetic check that catches a sign
    // flipped anywhere above.
    varianceToDate: round(a - b),
  };
}

/**
 * The statement.
 *
 * @param opts.months  stored opex records, any order, any fiscal year — the
 *                     ones outside this year are ignored rather than assumed.
 * @param opts.budget  the stored budget record, or null
 * @param opts.basis   "total" (the P&L as Xero prints it, the default here)
 *                     or "cash" (revaluations and depreciation removed)
 */
export function pnlView({
  fiscalYearStartYear,
  months = [],
  budget = null,
  basis = "total",
} = {}) {
  const keys = fiscalKeys(fiscalYearStartYear);
  const slotOfKey = new Map(keys.map((k, i) => [k, i]));
  const slotOf = (key) => (slotOfKey.has(key) ? slotOfKey.get(key) : null);

  const records = months
    .filter((m) => m && slotOf(m.month) !== null)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));

  const closedSlots = [...new Set(records.map((r) => slotOf(r.month)))].sort((a, b) => a - b);
  const closedKeys = closedSlots.map((s) => keys[s]);

  const series = budget?.series ?? null;
  const cash = basis === "cash";

  const revenue = buildSection({
    id: "revenue",
    title: "Income",
    sign: +1,
    records,
    slotOf,
    closedSlots,
    pick: (r) => r.revenueLines ?? [],
    pickTotal: (r) => r.revenue,
    // A record written before parser version 7 has the income total and no
    // lines at all, which the residual below turns into one honest row rather
    // than a section that mysteriously fails to add up.
    truncatedWhen: (r) => !Array.isArray(r.revenueLines),
    budgetLines: spreadEvenly(series?.revenueAccounts ?? []),
    note: "Recognised in the month the season departs, not when students pay.",
  });

  const directCosts = buildSection({
    id: "directCosts",
    title: "Cost of sales",
    sign: -1,
    records,
    slotOf,
    closedSlots,
    pick: (r) => r.programCostLines ?? r.programCostTopLines ?? [],
    pickTotal: (r) => r.programCost,
    // programCostTopLines is the twelve biggest only. Using it is better than
    // showing nothing, but it is NOT the section, and the difference has to
    // land in the residual rather than in the reader's assumptions.
    truncatedWhen: (r) => !Array.isArray(r.programCostLines),
    budgetLines: spreadEvenly(series?.directCostAccounts ?? []),
    note: "Supplier costs of running the programs, booked when the bill is raised.",
  });

  const overheads = buildSection({
    id: "overheads",
    title: "Operating expenses",
    sign: -1,
    records,
    slotOf,
    closedSlots,
    pick: (r) => (Array.isArray(r.lines) ? r.lines : r.topLines ?? [])
      .filter((l) => !(cash && l.nonCash)),
    pickTotal: (r) => (cash ? r.cashTotal : r.total),
    truncatedWhen: (r) => !Array.isArray(r.lines),
    budgetLines: spreadEvenly(series?.overheadAccounts ?? budget?.included ?? []),
    note: "Running the company, whether or not a program departs.",
  });

  const grossProfit = derived("grossProfit", "Gross profit",
    [{ section: revenue, sign: +1 }, { section: directCosts, sign: -1 }], closedSlots);
  const surplus = derived("surplus", "Surplus / (loss)",
    [{ section: revenue, sign: +1 }, { section: directCosts, sign: -1 },
     { section: overheads, sign: -1 }], closedSlots);

  const warnings = [];
  const missingRevenueSection = records.filter((r) => r.revenueSectionFound === false).map((r) => r.month);
  if (missingRevenueSection.length) {
    warnings.push(`No income section found in the P&L for ${missingRevenueSection.join(", ")} — those months read as zero income, which is a parsing problem rather than a trading one.`);
  }
  const truncated = [...new Set([
    ...revenue.truncatedMonths, ...directCosts.truncatedMonths, ...overheads.truncatedMonths,
  ])].sort();
  if (truncated.length) {
    warnings.push(`${truncated.length} month${truncated.length === 1 ? " was" : "s were"} stored before every line was kept (${truncated.join(", ")}). Their totals are right; the lines under them are incomplete, and the difference is shown as "not itemised". Re-read them with Overheads → Diagnostics → Refresh Xero data now.`);
  }
  if (!series) {
    warnings.push(budget
      ? "The stored budget predates the per-account detail, so there is no budget column on the lines. Refresh Xero data to rebuild it."
      : "No budget stored, so there is nothing to compare these figures against.");
  } else if (Array.isArray(series.monthsCovered) && series.monthsCovered.length < 12) {
    warnings.push(`The budget only covers ${series.monthsCovered.length} of the 12 months, so the full-year budget column is understated by whatever the missing months would have held.`);
  }
  const spreadCount = [
    series?.revenueAccounts, series?.directCostAccounts,
    series?.overheadAccounts ?? budget?.included,
  ].flatMap((a) => a ?? []).filter((b) => !Array.isArray(b.months)).length;
  if (spreadCount) {
    warnings.push(`${spreadCount} budget account${spreadCount === 1 ? " was" : "s were"} stored before the monthly split was kept, so their budget-to-date is an even twelfth per month rather than the real phasing. Refresh Xero data to replace it. Full-year budget figures are unaffected.`);
  }
  if (basis === "total" && overheads.nonCashTotal) {
    warnings.push(`${Math.abs(overheads.nonCashTotal).toLocaleString("en-NZ")} of operating expenses is non-cash (revaluations, depreciation). The budget deliberately excludes those accounts, so they show no budget and no variance — switch to "cash only" to take them out of the comparison entirely.`);
  }
  if (!closedSlots.length) {
    warnings.push("No months of this fiscal year have been read from Xero yet.");
  }

  return {
    fiscalYearStartYear,
    basis,
    monthKeys: keys,
    closedKeys,
    closedSlots,
    monthsClosed: closedSlots.length,
    lastActualMonth: closedKeys[closedKeys.length - 1] ?? null,
    budgetDescription: budget?.description ?? null,
    sections: [revenue, directCosts, overheads],
    grossProfit,
    surplus,
    /* Gross margin ON REVENUE, not as a markup on cost.
     *
     * The two differ by ten points or more and the markup always flatters —
     * 36% of cost is 26% of revenue. Stated once, here, so the page cannot
     * compute it the other way by accident. */
    grossMarginPct: revenue.total > 0
      ? Math.round((grossProfit.total / revenue.total) * 1000) / 10
      : null,
    warnings,
    source: "Xero Profit and Loss, by account, against Xero Budget Manager",
  };
}

export default { pnlView, fiscalKeys, normaliseAccount };
