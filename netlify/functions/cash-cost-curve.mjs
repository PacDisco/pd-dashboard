// netlify/functions/cash-cost-curve.mjs
//
// What the real cost phasing looks like, next to what the model assumes.
//
//   GET /api/cash-cost-curve
//
// Reads the stored transaction months — no Xero calls — and derives a curve per
// season from whatever tracking category holds the season. Returns the derived
// curves, the current model curve, and enough about the derivation's coverage
// and window that nobody has to take it on trust.
//
// Read role: this computes and returns, it changes nothing.

import { getStore } from "@netlify/blobs";
import { requireCashRole, json } from "./_shared/cash-access.mjs";
import { loadAssumptions, currentFiscalYear } from "./_shared/cash-store.mjs";
import { fiscalMonthKeys } from "./_shared/cash-xero.mjs";
import { deriveAllSeasonCurves, monthlyCostProfile, seasonWindows, deliverySplit } from "./_shared/cash-cost-curve.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-cost-curve");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const fy = Number(url.searchParams.get("fy")) || currentFiscalYear();
  // Which tracking category names the season. Not hardcoded: the code reads the
  // categories actually present and picks the one that looks like a season,
  // falling back to whatever is asked for.
  const wanted = url.searchParams.get("category");

  const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  const tenantId = latest?.orgs?.[0]?.tenantId;
  if (!tenantId) return json({ error: "No synced organisation yet." }, 409);

  const txStore = getStore({ name: "cash-xero-tx" });
  const opexStore = getStore({ name: "cash-xero-opex" });
  const txMonths = [];
  /* WHAT WAS ACTUALLY LOOKED AT.
   *
   * The panel told Jake "nothing tagged", "not measurable yet" and "no program
   * cost recorded" — three true statements that between them did not say
   * whether the problem was Pacific Discovery's bookkeeping or this code's
   * cache. It was the cache, twice. So the raw evidence travels with the
   * verdict now: how many months exist, how many line items were read, and how
   * much spend was never opened. "Nothing tagged" across 4,000 line items is a
   * fact about the books; across zero line items it is a fact about me. */
  const evidence = {
    tx: { expected: 0, stored: 0, byYear: {} },
    opex: { expected: 0, stored: 0, withProgramCost: 0, byYear: {} },
    lineItemsSeen: 0,
    billsFetched: 0,
    billsReferenced: 0,
  };
  // Program cost by month, from the P&L's Cost of Sales — the same report the
  // overheads come from, a different section. This needs no attribution at all
  // and covers 100% of program spend, which is why it is the profile's source
  // rather than the tagged transaction detail.
  const programCostByYear = {};
  // Both fiscal years: the current one alone is all pre-departure for Fall, so
  // a curve from it would have no tail.
  for (const y of [fy - 1, fy]) {
    const keys = fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`));
    evidence.tx.byYear[y] = { expected: keys.length, stored: 0 };
    evidence.opex.byYear[y] = { expected: keys.length, stored: 0, withProgramCost: 0 };
    evidence.tx.expected += keys.length;
    evidence.opex.expected += keys.length;

    for (const key of keys) {
      const rec = await txStore.get(`${tenantId}/${key}`, { type: "json" });
      if (rec?.costs) {
        txMonths.push({ month: key, ...rec.costs });
        evidence.tx.stored++;
        evidence.tx.byYear[y].stored++;
        evidence.lineItemsSeen += rec.costs.lineItemsSeen || 0;
        evidence.billsFetched += rec.billsFetched || 0;
        evidence.billsReferenced += rec.billsReferenced || 0;
      }

      const opex = await opexStore.get(`${tenantId}/${key}`, { type: "json" });
      if (opex) {
        evidence.opex.stored++;
        evidence.opex.byYear[y].stored++;
      }
      if (opex && Number.isFinite(opex.programCost)) {
        (programCostByYear[y] ??= {})[key] = opex.programCost;
        evidence.opex.withProgramCost++;
        evidence.opex.byYear[y].withProgramCost++;
      }
    }
  }

  /* The distinction that matters, named rather than left to be inferred.
   *
   * A stored month with no programCost was written by a parser that did not
   * know how to read Cost of Sales. That is a stale cache, and it clears itself
   * on the next refresh now the version stamp is bumped. A month that is not
   * stored at all was simply never fetched, and only a refresh brings it. The
   * two need different actions, so the page must not show them as one shrug. */
  evidence.diagnosis =
    evidence.tx.stored === 0 && evidence.opex.stored === 0 ? "nothing-fetched"
    : evidence.opex.stored > 0 && evidence.opex.withProgramCost === 0 ? "opex-stale"
    : evidence.opex.stored < evidence.opex.expected ? "history-short"
    : null;

  const profile = monthlyCostProfile(programCostByYear);

  if (!txMonths.length && !profile.perYear.length) {
    return json({
      error: "No stored months yet.",
      hint: "Run Overheads → Diagnostics → Force refetch every month first.",
    }, 409);
  }

  const categories = [...new Set(txMonths.flatMap((m) => m.categoriesSeen ?? []))];
  const category = wanted
    || categories.find((c) => /season/i.test(c))
    || categories[0]
    || "Season";

  const assumptions = await loadAssumptions(fy);
  const derived = deriveAllSeasonCurves({
    txMonths, programs: assumptions.programs ?? [], category,
    current: assumptions.costPhasing?.offsets ?? null,
  });

  // How much of the outgoing money each category can place, weighted across
  // months — the same figure the cost-attribution probe reports, surfaced here
  // so the page can say whether the curves rest on most of the spend or a
  // little of it.
  const totalOut = txMonths.reduce((s, m) => s + (m.totalOut || 0), 0);
  const coverage = Object.fromEntries(categories.map((c) => [c,
    totalOut > 0
      ? Math.round(txMonths.reduce((s, m) => s + (m.totalOut || 0) * ((m.coverage?.[c] ?? 0) / 100), 0) / totalOut * 1000) / 10
      : 0,
  ]));

  return json({
    fiscalYearStartYear: fy,
    categoriesSeen: categories,
    categoryUsed: category,
    coverageWeighted: coverage,
    monthsStored: txMonths.length,
    totalOutAcrossMonths: Math.round(totalOut),
    evidence,
    unattributable: {
      spendWithoutLineDetail: txMonths.reduce((s, m) => s + (m.spendWithoutLineDetail || 0), 0),
      unconverted: txMonths.reduce((s, m) => s + (m.unconverted || 0), 0),
    },
    ...derived,
    // The simpler route, and usually the better trade: what share of the year's
    // program cost goes out in each fiscal month. No attribution, 100% of the
    // spend, and the only assumption is that the calendar repeats.
    profile,
    // How the spend splits between the run-up, the delivery period and the
    // tail — measured against each season's own start and end dates rather
    // than assumed. This is what says whether duration matters enough to model.
    windows: seasonWindows(assumptions.programs ?? []),
    split: deliverySplit(txMonths, seasonWindows(assumptions.programs ?? []), category),
    canEdit: false,
  });
};
