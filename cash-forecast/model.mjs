/**
 * The variables Jake edits in the dashboard, and the shapes the engine works in.
 *
 * Everything here is an assumption someone can change. Nothing derived lives in
 * this file — that's the whole point of the rebuild. If a number can be
 * computed, it does not get stored.
 */
export const SEASONS = ["Fall", "Spring", "Summer"];
/**
 * Month (1-12) in which each season's revenue moves from deferred to sales.
 * Recognition happens the month BEFORE the season starts, so seasons run
 * Sep-, Feb- and Jul-onwards respectively.
 *
 * These are editable per fiscal year on the Overheads tab — a season that moves
 * its departure month moves its recognition month with it, and a wrong value
 * here is expensive: it can push a whole season's revenue out of the year.
 */
export const DEFAULT_RECOGNITION_MONTHS = {
    // Confirmed against Pacific Discovery's own P&L for FY26/27:
    //   Jun 2026  138,524  Summer
    //   Aug 2026  1,081,772  Fall      <- August, not September
    //   Jan 2026  578,382  Spring
    // Fall was set to September on the assumption that the season departs in
    // October. It departs 1 September, so the month before is August. The wrong
    // constant pushed Fall recognition to September of the PREVIOUS year, which
    // removed it from the fiscal year entirely.
    Fall: 8, // August    → season starts September
    Spring: 1, // January   → season starts February
    Summer: 6, // June      → season starts July
};
/* ------------------------------------------------------------------ */
export function emptyMonths() {
    return Array(12).fill(0);
}
/**
 * A booking curve that spreads enrolment over the year before departure,
 * weighted toward the six months out where most bookings actually close.
 * Tune it per season once you have the HubSpot data to back it.
 */
export const DEFAULT_BOOKING_CURVE = [
    { monthsBefore: 12, share: 0.04 },
    { monthsBefore: 11, share: 0.05 },
    { monthsBefore: 10, share: 0.06 },
    { monthsBefore: 9, share: 0.08 },
    { monthsBefore: 8, share: 0.1 },
    { monthsBefore: 7, share: 0.12 },
    { monthsBefore: 6, share: 0.14 },
    { monthsBefore: 5, share: 0.13 },
    { monthsBefore: 4, share: 0.11 },
    { monthsBefore: 3, share: 0.09 },
    { monthsBefore: 2, share: 0.05 },
    { monthsBefore: 1, share: 0.03 },
];
/**
 * Supplier deposits before departure, the bulk during delivery.
 * A placeholder shape — replace with your real supplier terms.
 */
export const DEFAULT_COST_PHASING = {
    offsets: [
        { monthOffset: -1, share: 0.25 },
        { monthOffset: 0, share: 0.45 },
        { monthOffset: 1, share: 0.25 },
        { monthOffset: 2, share: 0.05 },
    ],
};
export function defaultAssumptions(fiscalYearStartYear) {
    return {
        fiscalYearStartYear,
        // "YYYY-MM" of the last month closed off. Months at or before this show
        // Xero actuals; everything after is forecast. Null = all forecast.
        actualsThroughMonth: null,
        openingBalances: { NZD: 0, USD: 0 },
        // Where the 1 April balances come from. "xero" reads them off the stored
        // April bank summary — the opening column, which is the balance at the
        // first of the month and so is valid even while April is still running.
        // "manual" pins whatever is typed above. Per-currency fallback to the
        // typed figure applies either way: a currency Xero has no account for
        // must not silently become zero.
        openingBalanceSource: "xero",
        baseCurrency: "NZD",
        settlementCurrency: "USD",
        baseMinimumBuffer: 50_000,
        fxRates: { NZD: 1, USD: 1.65 },
        planningRateSource: "avg90",
        recognitionMonths: { ...DEFAULT_RECOGNITION_MONTHS },
        programs: [],
        defaultPaymentRules: {
            deposit: 1000,
            balanceDueDaysBeforeDeparture: 60,
            bookingCurve: DEFAULT_BOOKING_CURVE,
        },
        paymentRulesByProgram: {},
        costPhasing: DEFAULT_COST_PHASING,
        monthlyOverheads: emptyMonths(),
        monthlyCapital: emptyMonths(),
        monthlyTax: emptyMonths(),
        updatedAt: new Date().toISOString(),
        updatedBy: "system",
    };
}
