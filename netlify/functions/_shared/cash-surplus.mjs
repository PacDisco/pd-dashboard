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
  // A budget IS stored but was written before revenue and cost of sales were
  // kept. Different from no budget at all, and the remedy is different too.
  budgetStoredWithoutSeries = false,
  /* COST TO COMPLETE, rather than cost as planned.
   *
   * Without this the projected months replay the phasing curve regardless of
   * what the closed months actually spent. The seven open months would show the
   * same figures whether April to August had cost 300,000 or 600,000, so the
   * YEAR's total silently moved with the timing of the spend — which is exactly
   * backwards. A program costs what it costs; only the month it lands in should
   * depend on timing.
   *
   * With it, whatever is already incurred is deducted from the model's annual
   * program cost and only the REMAINDER is spread across the months still to
   * come, in the proportions the curve gives them.
   *
   * WHAT THIS CANNOT DO, AND WHY THE GAP IS REPORTED RATHER THAN ABSORBED
   * ---------------------------------------------------------------------
   * True-up assumes the total is right and only the timing varies. It cannot
   * tell "we paid the same money earlier" from "we spent more than planned",
   * and the second is a real cost problem that this would quietly swallow into
   * the remaining months. Telling them apart needs the spend attributed to
   * individual programs, and nothing in Pacific Discovery's supplier spend
   * carries a Program or Season tag.
   *
   * So the difference between what the curve expected of the closed months and
   * what those months actually cost is computed, returned, and named as
   * ambiguous. Absorbing it silently is the failure mode worth avoiding.
   */
  trueUp = true,
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

    // What the phasing curve says this month should cost, kept for EVERY month
    // including the closed ones. The closed months' planned figures are what
    // the true-up measures the actual spend against; without them there is
    // nothing to compare and the gap cannot be named.
    row.directCostsPlanned = num(fc?.programCostsOut);
    // What the pax model expected this month to RECOGNISE, kept for every month
    // including the closed ones. Never used to change a figure — only to
    // compare. A revenue gap means pax or price moved, or a season landed in a
    // different month than the model thinks; none of those are fixed by
    // rescaling something.
    row.revenuePlanned = num(fc?.recognisedRevenue);

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

  /* ---- cost to complete ---- */
  const raw = (rows, pick) => rows.reduce((s, r) => s + pick(r), 0);
  const modelYearTotal = raw(months, (r) => r.directCostsPlanned);
  const plannedInClosed = raw(actualRows, (r) => r.directCostsPlanned);
  const incurredInClosed = raw(actualRows, (r) => r.directCosts);
  const plannedRemaining = raw(projectedRows, (r) => r.directCostsPlanned);

  // Positive means the closed months cost MORE than the curve expected of them.
  // Which is either money brought forward or money overspent, and this data
  // cannot say which — see the trueUp doc above.
  const closedGap = incurredInClosed - plannedInClosed;

  let remaining = modelYearTotal - incurredInClosed;
  let floored = false;
  if (remaining < 0) {
    /* ALREADY PAST THE WHOLE YEAR'S BUDGETED PROGRAM COST.
     *
     * Left alone this would hand the remaining months a NEGATIVE cost, which
     * adds to the surplus — so a business that had overspent its entire annual
     * program cost by August would show the year improving from here. Floored
     * at zero and flagged instead: the honest reading is "nothing left in the
     * model to spend", which is itself the finding. */
    remaining = 0;
    floored = true;
  }

  const factor = plannedRemaining > 0 ? remaining / plannedRemaining : 0;
  // Remaining cost with nowhere to go: the curve assigns nothing to the months
  // still open, so scaling cannot place it. Reported rather than dropped.
  const unplaceable = plannedRemaining > 0 ? 0 : remaining;

  /* ---- revenue: compared, never trued up ----
   *
   * WHY THIS IS NOT THE SAME OPERATION AS THE COST TRUE-UP
   * ------------------------------------------------------
   * Program costs spread across months, so a difference between plan and books
   * is usually timing, and rescaling what remains is the right response.
   *
   * Revenue does not spread. A whole season recognises in ONE month. So a
   * difference between what the model expected of a closed month and what the
   * books show is never timing within that month — it is pax, or price, or the
   * season sitting in a different month entirely. Rescaling the remaining
   * months against it would take a pax shortfall in Fall and silently inflate
   * Spring to compensate, which is the opposite of useful.
   *
   * So this is measured and reported and changes nothing.
   */
  const plannedRevenueInClosed = raw(actualRows, (r) => r.revenuePlanned);
  const bookedRevenueInClosed = raw(actualRows, (r) => r.revenue);
  const revenueGap = bookedRevenueInClosed - plannedRevenueInClosed;

  /* A SEASON ON THE WRONG SIDE OF THE SEAM.
   *
   * Because revenue is season-sized and lands whole, a recognition month that
   * disagrees between the model and Xero does not produce a small variance —
   * it produces a missing or doubled season. Two shapes, both worth naming:
   *
   *   expected, absent   the model put a season in this closed month and the
   *                      books show nothing. Xero recognised it elsewhere, and
   *                      because the month is closed the model's figure was
   *                      discarded — so the season is missing from the year.
   *
   *   unexpected, booked the books recognised a season in this closed month
   *                      that the model did not expect. If the model also
   *                      projects it into a later open month, it is in the year
   *                      TWICE.
   *
   * The thresholds are deliberately large: this is looking for a season, not a
   * rounding difference.
   */
  const SEASON_SIZED = 50_000;
  const missingSeasons = actualRows.filter(
    (r) => r.revenuePlanned > SEASON_SIZED && r.revenue < r.revenuePlanned * 0.2);
  const surpriseSeasons = actualRows.filter(
    (r) => r.revenue > SEASON_SIZED && r.revenuePlanned < r.revenue * 0.2);
  // A surprise in a closed month matters most when the model ALSO has a season
  // of similar size still to come — that is the doubling case rather than
  // simply a month the model mistimed.
  const projectedSeasonTotal = raw(projectedRows, (r) => r.revenue);

  if (trueUp && actualRows.length && plannedRemaining > 0) {
    for (const row of projectedRows) {
      row.directCostsAsPlanned = row.directCosts;
      row.directCosts = row.directCostsPlanned * factor;
      row.surplus = row.revenue - row.directCosts - row.overheads;
      row.trueUpApplied = true;
    }
  }

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

  /* HOW MANY MONTHS SHOULD HAVE BEEN ACTUAL.
   *
   * Not the same as how many ARE. The difference is the whole point: five
   * months closed off in the model with no readable P&L is a sync problem, and
   * "nothing closed yet" — which is what the first version of this panel said —
   * states it as a fact about the business instead. */
  const inClosedRange = months.filter(
    (m) => Boolean(actualsThroughMonth) && m.key <= actualsThroughMonth).length;
  const unsynced = inClosedRange - actualRows.length;

  const warnings = [];
  if (budgetStoredWithoutSeries) {
    warnings.push("A budget is stored but it was read before this view existed, so it holds overheads and neither revenue nor cost of sales. Overheads → Diagnostics → Refresh Xero data now re-reads it.");
  } else if (!budgetSeries) {
    warnings.push("No budget stored for this year, so there is nothing to compare against. Overheads → Diagnostics → Refresh Xero data now pulls it.");
  } else if ((budgetSeries.monthsCovered?.length ?? 12) < 12) {
    const n = budgetSeries.monthsCovered.length;
    warnings.push(`The budget only covers ${n} of 12 months, so the budgeted surplus is for a part year and the comparison flatters whichever side has the missing months.`);
  }
  if (!actualRows.length && !inClosedRange) {
    warnings.push("No month has been closed off yet, so this is entirely a projection — the 'actual to date' column is empty by definition, not by omission.");
  } else if (!actualRows.length) {
    warnings.push(`${inClosedRange} month${inClosedRange === 1 ? " is" : "s are"} closed off in the model, but none of them has a P&L this code can read — so everything here is projected. The stored P&L months predate the revenue parser. Overheads → Diagnostics → Refresh Xero data now rewrites them.`);
  }
  const stale = months.filter((m) => m.projectedBecause === "no P&L stored for a closed month");
  if (stale.length) {
    warnings.push(`${stale.map((m) => m.key).join(", ")} ${stale.length === 1 ? "is" : "are"} closed off but ${stale.length === 1 ? "has" : "have"} no P&L stored, so ${stale.length === 1 ? "it is" : "they are"} projected rather than read. Overheads → Diagnostics → Refresh Xero data now.`);
  }
  /* A MISPLACED SEASON COMES FIRST, above everything else here.
   *
   * Every other warning on this panel is worth tens of thousands. These two are
   * worth a whole season — and we have already shipped this bug once, when Fall
   * was set to recognise in September for a season departing 1 September: the
   * revenue left the fiscal year entirely and deferred revenue went negative by
   * the same amount. Nobody spotted it from the totals. */
  for (const m of missingSeasons) {
    warnings.push(`${m.key}: the model expects ${Math.round(m.revenuePlanned).toLocaleString("en-NZ")} of revenue to be recognised this month and the books show ${Math.round(m.revenue).toLocaleString("en-NZ")}. The month is closed, so the model's figure is discarded and that season is MISSING from the year. Either Xero recognised it in a different month, or the recognition month on the Overheads tab is wrong for that season.`);
  }
  for (const m of surpriseSeasons) {
    warnings.push(`${m.key}: the books recognised ${Math.round(m.revenue).toLocaleString("en-NZ")} this month and the model expected ${Math.round(m.revenuePlanned).toLocaleString("en-NZ")}. If the model also projects that season into a later month, it is counted TWICE${projectedSeasonTotal > SEASON_SIZED ? ` — there is ${Math.round(projectedSeasonTotal).toLocaleString("en-NZ")} of projected revenue still to come, which is worth checking against the programs` : ""}. Check the season's recognition month against its departure date.`);
  }

  /* Revenue against the books, when the months line up.
   *
   * With the seasons in the right months this is the real question: are pax and
   * prices holding? Five per cent of a season is a couple of students. */
  if (!missingSeasons.length && !surpriseSeasons.length
      && plannedRevenueInClosed > 0
      && Math.abs(revenueGap) > Math.max(20_000, plannedRevenueInClosed * 0.05)) {
    const over = revenueGap > 0;
    warnings.push(`The closed months booked ${Math.abs(Math.round(revenueGap)).toLocaleString("en-NZ")} ${over ? "more" : "less"} revenue than the model expected of them (${Math.round(bookedRevenueInClosed).toLocaleString("en-NZ")} against ${Math.round(plannedRevenueInClosed).toLocaleString("en-NZ")}, ${Math.abs(Math.round((revenueGap / plannedRevenueInClosed) * 100))}%). Pax or prices have moved against what is entered. The projected months are NOT adjusted for this — revenue is reported, not trued up — so if the same gap holds for the seasons still to come, the extrapolation is ${over ? "understated" : "overstated"} by roughly the same proportion.`);
  }

  /* The true-up's own warnings, in the order they matter.
   *
   * A 5% gap is noise in a phasing curve that was invented in the first place.
   * Past that it is worth someone looking, because one of the two readings is a
   * real cost problem and the true-up has just spread it across the rest of the
   * year where it stops being visible. */
  if (floored) {
    warnings.push(`The closed months have already incurred ${Math.round(incurredInClosed).toLocaleString("en-NZ")} of program cost, more than the model's whole-year figure of ${Math.round(modelYearTotal).toLocaleString("en-NZ")}. The remaining months are shown at zero because there is nothing left in the model to spend — which is the finding, not a rounding. Either the programs cost more than entered, or pax have grown since.`);
  } else if (unplaceable > 0) {
    warnings.push(`${Math.round(unplaceable).toLocaleString("en-NZ")} of program cost is still to come, but the phasing curve puts nothing in the months that remain — so it cannot be placed and is missing from the extrapolation. Check the cost phasing against the programs still to depart.`);
  } else if (Math.abs(closedGap) > Math.max(5_000, plannedInClosed * 0.05)) {
    const over = closedGap > 0;
    warnings.push(`The closed months cost ${Math.abs(Math.round(closedGap)).toLocaleString("en-NZ")} ${over ? "more" : "less"} than the phasing curve expected of them (${Math.round(incurredInClosed).toLocaleString("en-NZ")} against ${Math.round(plannedInClosed).toLocaleString("en-NZ")}). That is either spend ${over ? "brought forward" : "still to come"} or the programs costing ${over ? "more" : "less"} than entered — and nothing in the supplier spend is tagged by program, so this cannot tell which. The remaining months have been scaled by ${factor.toFixed(2)} to hold the year's total at the model's figure.`);
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
    // Months the model considers closed, and how many of those could not be
    // read. The panel needs both to tell "nothing has happened yet" apart from
    // "five months have happened and I cannot see them".
    closedRangeMonths: inClosedRange,
    unsyncedClosedMonths: unsynced,
    /* THE GAP, NAMED RATHER THAN ABSORBED.
     *
     * The whole point of returning this is that the true-up is doing something
     * consequential and silently. Someone reading the extrapolated cost of
     * sales deserves to see that the closed months ran ahead of or behind the
     * curve, by how much, and that this figure has two possible meanings. */
    trueUp: {
      applied: Boolean(trueUp && actualRows.length && plannedRemaining > 0),
      modelYearTotal: Math.round(modelYearTotal),
      plannedInClosed: Math.round(plannedInClosed),
      incurredInClosed: Math.round(incurredInClosed),
      // Positive: the closed months cost more than the curve expected.
      closedGap: Math.round(closedGap),
      closedGapPct: plannedInClosed > 0
        ? Math.round((closedGap / plannedInClosed) * 1000) / 10 : null,
      remaining: Math.round(remaining),
      plannedRemaining: Math.round(plannedRemaining),
      // What the remaining months are scaled by. 1 means the closed months came
      // in exactly on the curve.
      factor: plannedRemaining > 0 ? Math.round(factor * 1000) / 1000 : null,
      floored,
      unplaceable: Math.round(unplaceable),
      // Stated here so no consumer has to reconstruct the caveat from the
      // numbers and get it slightly wrong.
      ambiguity: "A gap between planned and incurred is either spend brought forward or spend above plan. Telling them apart needs the cost attributed to individual programs, and none of the supplier spend carries a Program or Season tag.",
    },
    /* Revenue: measured against the books, never adjusted.
     *
     * `applied: false` is stated rather than left out, so nobody reading this
     * alongside the cost block assumes the same correction happened here. */
    revenueCheck: {
      applied: false,
      plannedInClosed: Math.round(plannedRevenueInClosed),
      bookedInClosed: Math.round(bookedRevenueInClosed),
      gap: Math.round(revenueGap),
      gapPct: plannedRevenueInClosed > 0
        ? Math.round((revenueGap / plannedRevenueInClosed) * 1000) / 10 : null,
      // Months where a whole season appears to be on the wrong side.
      missingSeasonMonths: missingSeasons.map((m) => m.key),
      surpriseSeasonMonths: surpriseSeasons.map((m) => m.key),
      projectedRevenueRemaining: Math.round(projectedSeasonTotal),
      basis: "A season recognises whole, in one month, so this is a pax and price check — not a timing one. Nothing here is rescaled.",
    },
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
