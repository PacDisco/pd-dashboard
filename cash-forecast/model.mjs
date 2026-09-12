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
/**
 * When the balance is actually paid, as shares by months before departure.
 *
 * The model used to land the whole balance in one month — the due date — which
 * is why the table showed cash arriving in two or three months a year and
 * nothing in between. Students pay across a range, with the bulk inside the last
 * 60 days, and for a cash forecast the month is the entire point.
 *
 * This shape is a starting point, not a measurement: 77% inside 60 days
 * (offsets 2, 1 and 0), with a tail running back six months. The real curve is
 * derivable from receivable receipts once those are flowing, and should replace
 * this the moment it is.
 */
export const DEFAULT_BALANCE_CURVE = [
    { monthsBefore: 6, share: 0.03 },
    { monthsBefore: 5, share: 0.04 },
    { monthsBefore: 4, share: 0.06 },
    { monthsBefore: 3, share: 0.10 },
    { monthsBefore: 2, share: 0.30 },
    { monthsBefore: 1, share: 0.37 },
    { monthsBefore: 0, share: 0.10 },
];
/**
 * When a program's money actually arrives, as shares of its FULL price by months
 * before departure.
 *
 * This replaces four separate inputs — deposit amount, the days-before-departure
 * rule, the booking curve and the balance curve. Every one of them was
 * unverifiable: with a single part-paid invoice per student, nothing in Xero
 * says which instalment a payment was, so the split could be wrong in ways
 * nothing could check.
 *
 * One curve is directly measurable from receivable receipts, which is the whole
 * point. The shape below is a starting estimate: a thin tail a year out where
 * deposits used to sit, then 72.5% inside 60 days (offsets 2, 1 and 0).
 */
export const DEFAULT_RECEIPTS_CURVE = [
    { monthsBefore: 12, share: 0.006 },
    { monthsBefore: 11, share: 0.008 },
    { monthsBefore: 10, share: 0.010 },
    { monthsBefore: 9, share: 0.013 },
    { monthsBefore: 8, share: 0.016 },
    { monthsBefore: 7, share: 0.019 },
    { monthsBefore: 6, share: 0.028 },
    { monthsBefore: 5, share: 0.035 },
    { monthsBefore: 4, share: 0.050 },
    { monthsBefore: 3, share: 0.090 },
    { monthsBefore: 2, share: 0.250 },
    { monthsBefore: 1, share: 0.340 },
    { monthsBefore: 0, share: 0.135 },
];
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
        // Where the overheads row comes from. "auto" takes closed months from
        // the P&L and the rest from Xero's budget, falling back to the typed
        // figures for any month neither covers. "manual" pins what is typed.
        overheadSource: "auto",
        // Which P&L figure a closed month uses. "total" is Total Operating
        // Expenses exactly as the P&L reports it. "cash" strips the non-cash
        // lines — bank revaluations and unrealised currency movements — which
        // move by tens of thousands a month here purely on the exchange rate.
        overheadBasis: "total",
        // Which Xero budget to read. Unset means the most recently updated one,
        // and whichever was used is reported back so it is never a mystery.
        xeroBudgetId: null,
        programs: [],
        defaultPaymentRules: {
            deposit: 1000,
            balanceDueDaysBeforeDeparture: 60,
            bookingCurve: DEFAULT_BOOKING_CURVE,
            balanceCurve: DEFAULT_BALANCE_CURVE,
            // Share of receipts that arrive already in NZD rather than the
            // program's price currency. Funds come in USD with the exception of
            // some students paying NZD directly; that portion never needs
            // converting, so it changes the treasury block without moving the
            // NZD-equivalent totals at the top of the table.
            //
            // It is NOT a hedge: an NZD payment is the USD price converted at
            // the day's rate, so it carries the same rate risk. See the note on
            // splitReceiptByCurrency in engine.mjs.
            nzdReceiptShare: 0,
            // The single receipts curve. When set it replaces deposit,
            // balanceDueDaysBeforeDeparture, bookingCurve and balanceCurve —
            // those stay only so a model saved before this keeps its numbers.
            receiptsCurve: DEFAULT_RECEIPTS_CURVE,
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
