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
 * Oct-, Feb- and Jul-onwards respectively.
 */
export const DEFAULT_RECOGNITION_MONTHS = {
    Fall: 9, // September → season starts October
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
        openingBalances: { NZD: 0, USD: 0 },
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
