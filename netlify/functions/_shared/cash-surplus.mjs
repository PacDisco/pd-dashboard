// netlify/functions/_shared/cash-surplus.mjs
//
// Extrapolated full-year surplus, against the budgeted one.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// This is the P&L question: revenue recognised in the year, less cost of sales
// incurred, less overheads, to a single profit or loss figure at 31 March —
// and the same figure as it was budgeted in April.
//
// It is NOT the cash forecast, and the two will disagree, often by a lot. A
// student pays a deposit in March for a program departing the following
// October: cash in March, revenue the following September. The gap sits in
// deferred revenue, which on these books runs to seven figures. Nothing in this
// module may add a figure from the cash forecast to a figure from the P&L.
//
// HOW THE EXTRAPOLATION WORKS
// ---------------------------
// Closed months come from the books. Remaining months come from the pax model —
// recognised revenue and program costs as the forecast engine computes them —
// plus budgeted overheads. That was a deliberate choice: the budget is the
// figure everyone agreed in April, but it cannot know that Spring is tracking
// 30 against a budgeted 40. Extrapolating from pax means the answer moves when
// enrolments move, which is the entire reason for looking at it in September
// rather than reading the budget again.
//
// THE TRAP THIS MODULE IS MOSTLY ABOUT
// ------------------------------------
// Every figure must come from exactly ONE side of the seam. A month that is
// both closed in the books and present in the model is the easy double count,
// and it does not look like an error — it looks like a good year.
//
// Pure — no I/O — so it runs against fixtures.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Fiscal slot 0-11 -> "YYYY-MM" for an April-start year. */
function slotKey(fyStart, slot) {
  const abs = 3 + slot;
  return `${fyStart + Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
}

/**
 * @param opts.fiscalYearStartYear
 * @param opts.actualsThroughMonth  "YYYY-MM" — the last month closed off. Months
 *        at or before this come from the P&L; everything after is projected.
 *        A month with no stored P&L record is projected even if it falls inside
 *        the closed range, and reported as such.
 * @param opts.opexByMonth  stored P&L records, keyed "YYYY-MM"
 * @param opts.forecastMonths  the engine's months — recognisedRevenue and
 *        programCostsOut per month, from the pax model
 * @param opts.budgetSeries  {revenue[], directCosts[], overheads[]}, all POSITIVE
 * @param opts.overheadsForward  twelve resolved overhead figures for months that
 *        have not happened (budget where there is one, typed otherwise)
 * @param opts.overheadBasis  "total" | "cash" — which P&L opex figure a closed
 *        month uses. Matches the cash forecast's own setting.
 */
export function surplusView({
  fiscalYearStartYear: fy,
  actualsThroughMonth = null,
  opexByMonth = {},
  forecastMonths = [],
  budgetSeries = null,
  overheadsForward = null,
  overheadBasis = "total",
} = {}) {
  const byKey = new Map(forecastMonths.map((m) => [m.key, m]));
  const months = [];

  for (let slot = 0; slot < 12; slot++) {
    const key = slotKey(fy, slot);
    const rec = opexByMonth[key];
    const fc = byKey.get(key);

    // A month counts as actual only if it is BOTH within the closed range and
    // actually present in the store with a revenue figure. Treating a closed
    // range as sufficient was the first version's bug in waiting: a month the
    // refresh had not reached yet would have contributed zero revenue and its
    // real overheads, which reads as a catastrophic month rather than a gap.
    const inClosedRange = Boolean(actualsThroughMonth) && key <= actualsThroughMonth;
    const hasRecord = Boolean(rec) && Number.isFinite(rec.revenue);
    const isActual = inClosedRange && hasRecord;

    const overheadActual = overheadBasis === "cash" ? rec?.cashTotal : rec?.total;

    const row = isActual
      ? {
          key, slot, source: "actual",
          revenue: num(rec.revenue),
          directCosts: num(rec.programCost),
          overheads: num(overheadActual),
          // A closed month whose P&L had no Cost of Sales section is not a
          // month that spent nothing on programs — it is a month this code
          // could not read. Flagged so the total can say so.
          costsUnread: rec.programCostSectionFound === false,
          revenueUnread: rec.revenueSectionFound === false,
        }
      : {
          key, slot, source: "projected",
          // From the pax model, via the engine. These are ACCRUAL figures:
          // recognisedRevenue is the season's revenue booked in its recognition
          // month, not the cash that arrived.
          revenue: num(fc?.recognisedRevenue),
          directCosts: num(fc?.programCostsOut),
          overheads: num(overheadsForward?.[slot] ?? fc?.overheads),
          costsUnread: false,
          revenueUnread: false,
          // Why this month was projected, which is not always "it is in the
          // future" — see the isActual comment above.
          projectedBecause: inClosedRange && !hasRecord ? "no P&L stored for a closed month" : "not closed yet",
        };

    row.surplus = row.revenue - row.directCosts - row.overheads;
    row.budget = budgetSeries
      ? {
          revenue: num(budgetSeries.revenue?.[slot]),
          directCosts: num(budgetSeries.directCosts?.[slot]),
          overheads: num(budgetSeries.overheads?.[slot]),
        }
      : null;
    if (row.budget) {
      row.budget.surplus = row.budget.revenue - row.budget.directCosts - row.budget.overheads;
    }
    months.push(row);
  }

  const sum = (rows, pick) => Math.round(rows.reduce((s, r) => s + pick(r), 0));
  const actualRows = months.filter((m) => m.source === "actual");
  const projectedRows = months.filter((m) => m.source === "projected");

  const line = (pick) => ({
    actual: sum(actualRows, pick),
    projected: sum(projectedRows, pick),
    // The extrapolation: what happened, plus what is expected. Every month
    // contributes to exactly one of the two, which is the whole discipline
    // here — the seam is the place a surplus view goes wrong.
    extrapolated: sum(months, pick),
    budget: budgetSeries ? sum(months, (r) => (r.budget ? pick(r.budget) : 0)) : null,
  });

  const revenue = line((r) => r.revenue);
  const directCosts = line((r) => r.directCosts);
  const overheads = line((r) => r.overheads);
  const surplus = line((r) => r.surplus);

  const variance = budgetSeries
    ? {
        revenue: revenue.extrapolated - revenue.budget,
        // A cost coming in UNDER budget is favourable, so the variance is
        // stated budget-minus-actual for costs and actual-minus-budget for
        // revenue. Both are therefore positive when the news is good, which is
        // the only convention anyone reads correctly at a glance.
        directCosts: directCosts.budget - directCosts.extrapolated,
        overheads: overheads.budget - overheads.extrapolated,
        surplus: surplus.extrapolated - surplus.budget,
      }
    : null;

  const warnings = [];
  if (!budgetSeries) {
    warnings.push("No budget stored for this year, so there is nothing to compare against. Diagnostics → Refresh from Xero pulls it.");
  } else if ((budgetSeries.monthsCovered?.length ?? 12) < 12) {
    const n = budgetSeries.monthsCovered.length;
    warnings.push(`The budget only covers ${n} of 12 months, so the budgeted surplus is for a part year and the comparison flatters whichever side has the missing months.`);
  }
  if (!actualRows.length) {
    warnings.push("No month has been closed off yet, so this is entirely a projection — the 'actual to date' column is empty by definition, not by omission.");
  }
  const stale = months.filter((m) => m.projectedBecause === "no P&L stored for a closed month");
  if (stale.length) {
    warnings.push(`${stale.map((m) => m.key).join(", ")} ${stale.length === 1 ? "is" : "are"} closed off but ${stale.length === 1 ? "has" : "have"} no P&L stored, so ${stale.length === 1 ? "it is" : "they are"} projected rather than read. Refresh from Xero.`);
  }
  const unread = months.filter((m) => m.costsUnread || m.revenueUnread);
  if (unread.length) {
    warnings.push(`${unread.map((m) => m.key).join(", ")}: the P&L had no ${unread[0].revenueUnread ? "revenue" : "cost of sales"} section this code could find, so that month contributes zero rather than its real figure.`);
  }

  return {
    fiscalYearStartYear: fy,
    months,
    actualMonths: actualRows.length,
    projectedMonths: projectedRows.length,
    lastActualMonth: actualRows.length ? actualRows[actualRows.length - 1].key : null,
    lines: { revenue, directCosts, overheads, surplus },
    variance,
    basis: {
      overheadBasis,
      // Stated rather than implied, because "extrapolated" means nothing on its
      // own — the reader has to know which parts came from where.
      projection: "pax model (recognised revenue and program costs), with budgeted overheads",
      accrual: true,
    },
    warnings,
  };
}

export default { surplusView };
