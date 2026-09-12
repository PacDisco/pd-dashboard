/**
 * Starting values for the Cash Forecast model.
 *
 * Everything here is taken from "26/27 FY EDA Group Cash Forecast v5" so the
 * first version of the model is traceable to the workbook it replaces, EXCEPT
 * the three things flagged PLACEHOLDER below. Those are guesses, and the
 * forecast means nothing until they are replaced.
 *
 * This is a starting point to edit from, not an answer. It exists so nobody has
 * to hand-type ten programs into a web form.
 */

/**
 * Fixed and variable costs: verbatim from the workbook's "Fixed & Variable
 * Costs" sheet, which labels them NZD.
 *
 * Prices: the workbook's pax values — 15,500 semester / 10,500 mini / 7,000
 * summer — which are USD. The Revenue sheet multiplies them by the USD:NZD rate
 * (cells F2/F4/F6/F11/F13/F15/F20), so a Fall place is ~NZD 26,000, not 15,500.
 *
 * Pax: the Revenue sheet's own season forecasts for FY26/27 — Fall Semester 51,
 * Fall Mini 0, Spring Semester 40, Spring Mini 20, Summer 14.
 *
 * PLACEHOLDER 1: the per-program split of those season totals. The workbook has
 * season totals only, so these are spread evenly within each season. Almost
 * certainly wrong for any individual program.
 */
// name, season, fixedCost (NZD), variableCostPerPax (NZD), price (USD), pax
const PROGRAMS = [
  ["Aus Bali",    "Fall",   106_970,  6_198, 15_500, 13],
  ["CAS",         "Fall",    71_077,  9_804, 15_500, 12],
  ["NZA",         "Fall",   142_113,  3_557, 15_500, 13],
  ["Poly J",      "Fall",   117_085,  4_861, 15_500, 13],
  ["Aus Mini",    "Fall",    60_119,  5_038, 10_500,  0],
  ["SAS",         "Spring",  52_488, 11_498, 15_500, 20],
  ["SEA",         "Spring",  72_991,  8_884, 15_500, 20],
  ["CR Mini",     "Spring",  29_717,  7_328, 10_500, 20],
  ["Hawaii Mini", "Summer",  92_360,  3_597,  7_000,  7],
  ["Thai Mini",   "Summer",  39_314,  6_033,  7_000,  7],
];

/**
 * PLACEHOLDER 2: departure and return dates, keyed to each season's start
 * (the month after recognition — Fall Oct, Spring Feb, Summer Jul). Real
 * departure dates drive the whole cash timeline, so these matter a lot.
 */
function seasonDates(fy) {
  return {
    Fall:   [`${fy}-10-01`,     `${fy}-12-10`],
    Spring: [`${fy + 1}-02-05`, `${fy + 1}-04-15`],
    Summer: [`${fy}-07-01`,     `${fy}-08-15`],
  };
}

/**
 * PLACEHOLDER 3: supplier cost phasing — 25% the month before departure, 45%
 * in month, 25% after, 5% the month after that. Invented. Replace with your
 * actual supplier payment terms.
 *
 * The deposit and balance-due days are REAL (2,500 / 90 days). The booking
 * curve is still a plausible shape rather than a measured one — HubSpot deal
 * data could give you the real distribution, and it matters more now that the
 * deposit is 2,500 rather than 1,000.
 */
export function seedAssumptions(fiscalYearStartYear) {
  const fy = fiscalYearStartYear;
  const dates = seasonDates(fy);

  return {
    fiscalYearStartYear: fy,

    // The workbook's single -501,125 opening, all attributed to NZD because it
    // has no USD/NZD split. Replace with the real 1 April balance of each account.
    // Overridden by April's bank summary once it has synced — this is only the
    // fallback for a year Xero has no April for.
    openingBalances: { NZD: -501_125, USD: 0 },
    openingBalanceSource: "xero",
    baseCurrency: "NZD",
    settlementCurrency: "USD",
    baseMinimumBuffer: 50_000,

    // Overridden by the live series unless planningRateSource is "manual".
    fxRates: { NZD: 1, USD: 1.65 },
    planningRateSource: "avg90",

    // Fall departs 1 September, so recognition is August — confirmed against the
    // FY26/27 P&L, which books 1,081,772 of Fall sales in Aug 2026.
    recognitionMonths: { Fall: 8, Spring: 1, Summer: 6 },

    programs: PROGRAMS.map(([name, season, fixedCost, variableCostPerPax, price, paxForecast]) => ({
      id: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      season,
      startDate: dates[season][0],
      endDate: dates[season][1],
      price,
      currency: "USD",
      fixedCost,
      variableCostPerPax,
      costCurrency: "NZD",
      paxForecast,
      xeroTrackingOption: name,
      active: true,
    })),

    defaultPaymentRules: {
      // Real rules, confirmed Sept 2026: 2,500 deposit at booking, balance due
      // within 90 days of the program. Deposit is in the program's currency —
      // USD, same as the price — so it is ~NZD 4,100 at current rates.
      deposit: 2500,
      balanceDueDaysBeforeDeparture: 90,
      bookingCurve: [
        { monthsBefore: 12, share: 0.04 },
        { monthsBefore: 11, share: 0.05 },
        { monthsBefore: 10, share: 0.06 },
        { monthsBefore: 9, share: 0.08 },
        { monthsBefore: 8, share: 0.10 },
        { monthsBefore: 7, share: 0.12 },
        { monthsBefore: 6, share: 0.14 },
        { monthsBefore: 5, share: 0.13 },
        { monthsBefore: 4, share: 0.11 },
        { monthsBefore: 3, share: 0.09 },
        { monthsBefore: 2, share: 0.05 },
        { monthsBefore: 1, share: 0.03 },
      ],
      // When the balance actually lands. Confirmed shape, not confirmed numbers:
      // the bulk arrives within 60 days of the program, so 77% sits in the last
      // three offsets. Replace with the measured curve once receivable receipts
      // are flowing — this is the single input that decides which month the big
      // money shows up in.
      // The single receipts curve — what share of a program's price arrives
      // N months before departure. Replaces the deposit/balance split entirely;
      // 72.5% lands inside 60 days. A starting estimate, replaceable with the
      // measured distribution once receivable receipts are flowing.
      receiptsCurve: [
        { monthsBefore: 12, share: 0.006 }, { monthsBefore: 11, share: 0.008 },
        { monthsBefore: 10, share: 0.010 }, { monthsBefore: 9, share: 0.013 },
        { monthsBefore: 8, share: 0.016 }, { monthsBefore: 7, share: 0.019 },
        { monthsBefore: 6, share: 0.028 }, { monthsBefore: 5, share: 0.035 },
        { monthsBefore: 4, share: 0.050 }, { monthsBefore: 3, share: 0.090 },
        { monthsBefore: 2, share: 0.250 }, { monthsBefore: 1, share: 0.340 },
        { monthsBefore: 0, share: 0.135 },
      ],

      // PLACEHOLDER: the share of receipts arriving in NZD rather than USD.
      // Funds come in USD with the exception of some students paying NZD. Set
      // it from the real split — it decides how much has to be converted and so
      // how much of the year is exposed to the rate.
      nzdReceiptShare: 0,
      balanceCurve: [
        { monthsBefore: 6, share: 0.03 },
        { monthsBefore: 5, share: 0.04 },
        { monthsBefore: 4, share: 0.06 },
        { monthsBefore: 3, share: 0.10 },
        { monthsBefore: 2, share: 0.30 },
        { monthsBefore: 1, share: 0.37 },
        { monthsBefore: 0, share: 0.10 },
      ],
    },
    paymentRulesByProgram: {},
    costPhasing: {
      offsets: [
        { monthOffset: -1, share: 0.25 },
        { monthOffset: 0, share: 0.45 },
        { monthOffset: 1, share: 0.25 },
        { monthOffset: 2, share: 0.05 },
      ],
    },

    // The workbook's own Overheads and Capital rows, April first.
    monthlyOverheads: [71_450, 65_211, 56_711, 72_018, 56_488, 58_352,
                       71_888, 61_543, 56_693, 73_523, 62_003, 53_561],
    monthlyCapital: Array(12).fill(10_999),
    // GST and PAYE belong here and are absent from the workbook entirely.
    monthlyTax: Array(12).fill(0),

    updatedAt: new Date().toISOString(),
    updatedBy: "seed",
  };
}

export default { seedAssumptions };
