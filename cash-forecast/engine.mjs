/**
 * The forecast engine.
 *
 * Pure functions: assumptions in, monthly cash flow out. No I/O, no dates read
 * from the clock, no stored results. Every figure the dashboard shows is
 * recomputed from the variables, which is the whole reason for the rebuild —
 * there is nowhere for a hardcoded number or a balancing plug to hide.
 *
 * Two separate timelines, deliberately kept apart:
 *
 *   CASH        when students actually pay — deposits at booking, balance a set
 *               number of days before departure. This drives the bank position.
 *
 *   RECOGNITION when revenue moves from deferred to sales. Income for a season
 *               arrives over the months up to AND INCLUDING its departure month,
 *               so the engine holds the DEADLINE — the departure month — and
 *               leaves the run-up to the books. This drives the P&L view and
 *               reconciles to Xero, where the gap between the two timelines sits
 *               in deferred revenue.
 *
 * Conflating those two is what makes the current workbook hard to trust.
 */
/* ------------------------------------------------------------------ *
 * Fiscal calendar helpers. Fiscal year runs April → March.
 * ------------------------------------------------------------------ */
const MONTH_LABELS = [
    "Apr", "May", "Jun", "Jul", "Aug", "Sep",
    "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];
/** Calendar year and month (1-12) for a fiscal slot 0-11. */
export function fiscalSlotToDate(fyStart, slot) {
    const absolute = 3 + slot; // April is calendar month 4 → index 3
    return {
        year: fyStart + Math.floor(absolute / 12),
        month: (absolute % 12) + 1,
    };
}
/** Fiscal slot 0-11 for a calendar year/month, or null if outside the year. */
export function dateToFiscalSlot(fyStart, year, month) {
    const slot = (year - fyStart) * 12 + (month - 1) - 3;
    return slot >= 0 && slot < 12 ? slot : null;
}
/**
 * Months of runway the table must always show, counting the current month.
 *
 * Two fiscal years. Changing this one number changes the whole horizon, and it
 * is a round number of years on purpose: the floor below it is the same value,
 * so on 1 April the table is EXACTLY two fiscal years, Apr–Mar and Apr–Mar,
 * with no ragged remainder. Any value that is not a multiple of twelve gives up
 * that property.
 */
export const MONTHS_AHEAD = 24;

/**
 * How many months the table runs for.
 *
 * WHY THIS IS NOT THE FISCAL YEAR
 * -------------------------------
 * A fiscal-year table is the right shape for reporting and the wrong shape for
 * cash. In September it showed seven months ahead; by February it would have
 * shown two. The months a business most needs to see — is there money in
 * March, is there money in June — drop off the right-hand edge precisely as
 * they get close enough to matter.
 *
 * So the horizon is whichever is longer: the fiscal year (always whole, so year
 * totals and the annual comparison still mean what they meant), or MONTHS_AHEAD
 * from today. Both, not either.
 *
 * The consequence is that the table changes width through the year — 24 columns
 * each April, growing to 35 by the following March, then back to 24. That is
 * the honest shape of "whole fiscal years AND two years of runway": holding the
 * width fixed would mean either truncating the far end or letting the near end
 * shrink, and the near end shrinking is the failure this replaced.
 */
export function horizonLength(fyStart, today = new Date(), monthsAhead = MONTHS_AHEAD) {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() + 1;
    // monthsAhead from the CURRENT month INCLUSIVE: this month plus the rest.
    const lastNeeded = (y - fyStart) * 12 + (m - 1) - 3 + (monthsAhead - 1);
    // The floor is whole fiscal years, never a bare twelve: a horizon of 24
    // that fell back to 12 before the year started would shrink rather than
    // grow, which is the opposite of the point.
    const wholeYears = Math.ceil(monthsAhead / 12) * 12;
    return Math.max(wholeYears, lastNeeded + 1);
}
/**
 * Slot within the horizon, or null if before the fiscal year or past the end.
 *
 * Replaces dateToFiscalSlot everywhere money is placed. Using the fiscal
 * version for that was what made the tail impossible: a cost or receipt landing
 * in April 2027 returned null and was silently dropped, so extending the table
 * without this would have produced empty months that looked like a finding.
 */
export function dateToHorizonSlot(fyStart, year, month, length) {
    const slot = (year - fyStart) * 12 + (month - 1) - 3;
    return slot >= 0 && slot < length ? slot : null;
}
function monthKey(year, month) {
    return `${year}-${String(month).padStart(2, "0")}`;
}
/** Add whole months to a year/month pair, handling year rollover both ways. */
function addMonths(year, month, delta) {
    const zero = year * 12 + (month - 1) + delta;
    return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 };
}
function parseISODate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return { year: y, month: m, day: d };
}
/** Shift an ISO date by a number of days, returning year/month. */
function shiftDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
/**
 * The month by which a program's revenue must be fully recognised: the month it
 * departs in.
 *
 * THIS REPLACED A SEASON-LEVEL CONSTANT, AND THE DIFFERENCE MATTERS
 * -----------------------------------------------------------------
 * The model used to hold one recognition month per season — Fall = August — and
 * land the whole season there in a single lump. Pacific Discovery's books do
 * something else: income for a season arrives over the months up to AND
 * INCLUDING the departure month. Summer departs 2 July and booked 140,439 in
 * June with 568 in July. Fall departs 10 September and booked 1,085,804 in
 * August with the remainder still landing in September.
 *
 * With a single month the model was wrong twice over. It put Fall a month early,
 * so once August closed the model's figure was discarded and September — where
 * the rest actually lands — was projected at zero. The season's tail existed in
 * neither column. And the closed-month comparison then read a season that had
 * not finished as a 25% pax shortfall, which is how a timing artefact gets
 * reported as a commercial problem.
 *
 * So the deadline is what the model holds, and the run-up is left to the books.
 * Whatever has been recognised by the last closed month is fact; the remainder
 * lands here. That cannot be wrong about the YEAR, which is the number being
 * reported, and it is honest about being approximate month to month.
 */
export function recognitionMonthFor(program) {
    const start = parseISODate(program.startDate);
    return { year: start.year, month: start.month };
}

/**
 * The old season-constant behaviour, kept only so a saved model that still has
 * `recognitionMonths` can be compared against the new placement while someone
 * decides. Nothing in the forecast calls this.
 */
export function legacyRecognitionMonthFor(program, recognitionMonths) {
    const target = recognitionMonths?.[program.season];
    const start = parseISODate(program.startDate);
    if (!target) return { year: start.year, month: start.month };
    // Search back from the departure month INCLUSIVE.
    //
    // Starting at -1 looks right — "the month before the season starts" — but it
    // breaks precisely when a program departs IN its own recognition month. A
    // Fall program departing 1 September would skip September 2026 and match
    // September 2025: revenue recognised a full year early, so it disappears
    // from the fiscal year entirely and deferred revenue goes deeply negative to
    // compensate. Inclusive costs nothing for the normal case (an October
    // departure still recognises in September) and removes a twelve-month error
    // from the edge case.
    for (let back = 0; back <= 12; back++) {
        const candidate = addMonths(start.year, start.month, -back);
        if (candidate.month === target)
            return candidate;
    }
    // Unreachable for any target in 1-12, but keep the function total.
    return addMonths(start.year, start.month, -1);
}
/* ------------------------------------------------------------------ */
function rulesFor(assumptions, program) {
    const override = assumptions.paymentRulesByProgram[program.id] ?? {};
    return {
        ...assumptions.defaultPaymentRules,
        ...override,
        bookingCurve: override.bookingCurve ?? assumptions.defaultPaymentRules.bookingCurve,
        balanceCurve: override.balanceCurve ?? assumptions.defaultPaymentRules.balanceCurve,
        nzdReceiptShare: override.nzdReceiptShare ?? assumptions.defaultPaymentRules.nzdReceiptShare,
        receiptsCurve: override.receiptsCurve ?? assumptions.defaultPaymentRules.receiptsCurve,
    };
}
function toBase(amount, currency, fxRates) {
    const rate = fxRates[currency];
    if (rate === undefined) {
        // Caller surfaces this as a warning; treating it as 1 would silently
        // understate a USD program by 65%, which is worse than an obvious zero.
        return NaN;
    }
    return amount * rate;
}
/** Normalise shares to sum to 1, tolerating hand-entered curves that don't. */
function normalise(items) {
    const total = items.reduce((s, i) => s + i.share, 0);
    if (total === 0)
        return items;
    return items.map((i) => ({ ...i, share: i.share / total }));
}
/* ------------------------------------------------------------------ */
/**
 * @param assumptions  the editable model
 * @param actualsByMonth  { "2026-04": { byCurrency: { NZD: {received,spent,closing}, ... } } }
 *        Months at or before `assumptions.actualsThroughMonth` are replaced with
 *        these figures and the forecast re-bases onto the real closing balance.
 */
/**
 * Add a receipt to a month's season bucket.
 *
 * Kept as a helper rather than inlined twice because deposits and balances are
 * accumulated in two different places, and a season silently missing from one
 * of them would be invisible — the month total would still be right.
 */
function addSeasonReceipt(row, season, amountInBase) {
    if (!season || !amountInBase)
        return;
    row.receiptsBySeason[season] = (row.receiptsBySeason[season] || 0) + amountInBase;
}
/**
 * Put a receipt into the right account, splitting it by the currency it arrives
 * in.
 *
 * Most students pay in USD; some pay in NZD. The NZD portion lands straight in
 * the base account and never needs converting.
 *
 * DECIDED, September 2026: an NZD payment is the USD price converted at the
 * day's rate, NOT a separately-held NZD price. So this is an operational saving,
 * not a hedge — the amount still moves with the rate, and the closing position
 * and the sensitivity table are unchanged at any share. Do not "fix" the
 * sensitivity to respond to this number; it is correct that it does not.
 *
 * If PD ever starts quoting a fixed NZD price, that is a different model: those
 * receipts become rate-independent and the share genuinely reduces exposure.
 *
 * The base-stated total is identical either way: a student paying NZD pays the
 * NZD equivalent of the same price. So `Deposits in`, `Balances in` and `Cash in`
 * do not move. Only the treasury rows do — which is exactly the distinction the
 * top block and the treasury block exist to keep apart.
 */
function baseCurrencyName(a) { return a.baseCurrency || "NZD"; }
function splitReceiptByCurrency(row, nativeAmount, receiptRate, receiptsAreFx, nzdShare) {
    if (!receiptsAreFx) {
        // Already priced in base — there is nothing to split.
        row.baseIn += nativeAmount;
        return;
    }
    const share = Math.min(Math.max(Number(nzdShare) || 0, 0), 1);
    row.fxIn += nativeAmount * (1 - share);
    row.baseIn += nativeAmount * receiptRate * share;
}
export function buildForecast(assumptions, actualsByMonth = {}, { today = new Date(), monthsAhead = MONTHS_AHEAD } = {}) {
    const fy = assumptions.fiscalYearStartYear;
    const warnings = [];
    const horizon = horizonLength(fy, today, monthsAhead);
    const months = Array.from({ length: horizon }, (_, slot) => {
        const { year, month } = fiscalSlotToDate(fy, slot);
        return {
            key: monthKey(year, month),
            label: `${MONTH_LABELS[slot % 12]} ${String(year).slice(2)}`,
            year,
            month,
            // Past the fiscal year the model is running on assumptions nobody
            // has entered yet: there are no FY27/28 programs, so no student
            // money arrives and no program cost goes out. Every consumer needs
            // to be able to tell those months apart from real ones, or the
            // cliff where the programs stop reads as a finding about the
            // business rather than a gap in the inputs.
            beyondFiscalYear: slot >= 12,
            depositsIn: 0,
            balancesIn: 0,
            // Receipts from the single curve. Deposits and balances stay zero
            // when this is in use, and vice versa — never both.
            revenueIn: 0,
            // Receipts split by season, base currency. The actuals side can only
            // report a season total — one part-paid invoice per student means
            // nothing on a payment says whether it was the deposit or the
            // balance — so the forecast has to offer a comparable shape or the
            // two can never be set against each other.
            receiptsBySeason: {},
            cashIn: 0,
            programCostsOut: 0,
            overheads: 0,
            capital: 0,
            tax: 0,
            cashOut: 0,
            net: 0,
            fxOpening: 0, fxIn: 0, fxOut: 0, fxConverted: 0, fxClosing: 0,
            isActual: false, actualSource: null, grossIncludesTransfers: false,
            baseOpening: 0, baseIn: 0, baseFromConversion: 0, baseOut: 0, baseClosing: 0,
            opening: 0,
            closing: 0,
            recognisedRevenue: 0,
            deferredRevenueBalance: 0,
        };
    });
    const contributions = [];
    // Cash collected per program across all time, so deferred revenue can be
    // tracked even when collection starts before this fiscal year.
    let deferredOpening = 0;
    for (const program of assumptions.programs) {
        if (!program.active)
            continue;
        const pax = program.paxForecast;
        // Price and costs convert independently — selling in USD while paying
        // suppliers in NZD is the normal case here, not an edge case.
        const costCurrency = program.costCurrency || assumptions.baseCurrency;
        // Cash is tracked in the currency it is actually received and paid in.
        // `price` stays native; `priceInBase` is only for revenue recognition and
        // margin, which are accounting views rather than bank movements.
        const price = program.price;
        const priceInBase = toBase(program.price, program.currency, assumptions.fxRates);
        const fixedCost = toBase(program.fixedCost, costCurrency, assumptions.fxRates);
        const variableCost = toBase(program.variableCostPerPax, costCurrency, assumptions.fxRates);
        // Receipts either land in the settlement account or straight into base.
        const receiptsAreFx = program.currency !== assumptions.baseCurrency;
        const receiptRate = assumptions.fxRates[program.currency] ?? 1;
        if (receiptsAreFx && program.currency !== assumptions.settlementCurrency) {
            warnings.push(`${program.name}: priced in ${program.currency}, which is neither the base (${assumptions.baseCurrency}) nor the settlement currency (${assumptions.settlementCurrency}) — its receipts are treated as ${assumptions.settlementCurrency}.`);
        }
        if (Number.isNaN(priceInBase)) {
            warnings.push(`${program.name}: no FX rate for ${program.currency} — excluded from the forecast.`);
            continue;
        }
        if (Number.isNaN(fixedCost) || Number.isNaN(variableCost)) {
            warnings.push(`${program.name}: no FX rate for ${costCurrency} — excluded from the forecast.`);
            continue;
        }
        const rules = rulesFor(assumptions, program);
        // Share of this program's receipts that arrive already in base currency.
        // Most funds come in USD; some students pay NZD directly.
        const nzdShare = Math.min(Math.max(Number(rules.nzdReceiptShare) || 0, 0), 1);
        if (Number(rules.nzdReceiptShare) > 1) {
            warnings.push(`${program.name}: the ${baseCurrencyName(assumptions)} receipt share is above 100% — capped. It is a share, not a percentage of a percentage.`);
        }
        const grossRevenue = pax * priceInBase;
        const totalCost = fixedCost + variableCost * pax;
        const deposit = Math.min(rules.deposit, price);
        if (rules.deposit > price) {
            warnings.push(`${program.name}: deposit exceeds the program price — capped at the price.`);
        }
        const balance = price - deposit;
        /* ---- cash in ---- */
        const departure = parseISODate(program.startDate);

        // ONE RECEIPTS CURVE, when it is set.
        //
        // Deposits and balances were modelled separately for months, and every
        // part of that split turned out to be unverifiable: with one part-paid
        // invoice per student, nothing in Xero says which instalment a payment
        // was. Four inputs — deposit amount, the 60/90-day rule, the booking
        // curve and the balance curve — could each be wrong in a way nothing
        // could check.
        //
        // This is one curve: the share of a program's price that arrives N
        // months before departure. It is directly measurable from receivable
        // receipts, which is the whole argument for it.
        //
        // The deposit/balance path below still runs for a model that has no
        // receipts curve, so nothing saved changes until someone opts in.
        const receiptsCurve = rules.receiptsCurve?.length
            ? normalise(rules.receiptsCurve)
            : null;

        if (receiptsCurve) {
            for (const point of receiptsCurve) {
                const month = addMonths(departure.year, departure.month, -point.monthsBefore);
                const slot = dateToHorizonSlot(fy, month.year, month.month, horizon);
                const cash = pax * price * point.share;
                const inBase = cash * receiptRate;
                if (slot !== null) {
                    months[slot].revenueIn += inBase;
                    addSeasonReceipt(months[slot], program.season, inBase);
                    splitReceiptByCurrency(months[slot], cash, receiptRate, receiptsAreFx, nzdShare);
                }
                else if (month.year * 12 + month.month < fy * 12 + 4) {
                    // Collected before the year opened — already in deferred.
                    deferredOpening += inBase;
                }
            }
        }
        else {
            const curve = normalise(rules.bookingCurve);
            // A null monthsBefore means "use the day-precise due date" — the legacy
            // single-lump path, kept so an existing model does not silently change.
            const balancePoints = rules.balanceCurve?.length
                ? normalise(rules.balanceCurve)
                : [{ monthsBefore: null, share: 1 }];
            for (const point of curve) {
                const paxAtThisPoint = pax * point.share;
                // Deposits land in the month the booking is made.
                const bookingMonth = addMonths(departure.year, departure.month, -point.monthsBefore);
                const bookingSlot = dateToHorizonSlot(fy, bookingMonth.year, bookingMonth.month, horizon);
                const depositCash = paxAtThisPoint * deposit;
                const depositInBase = depositCash * receiptRate;
                if (bookingSlot !== null) {
                    // Headline rows are stated in base currency so they can be added up.
                    // The treasury rows below stay in the currency actually received.
                    months[bookingSlot].depositsIn += depositInBase;
                    addSeasonReceipt(months[bookingSlot], program.season, depositInBase);
                    splitReceiptByCurrency(months[bookingSlot], depositCash, receiptRate, receiptsAreFx, nzdShare);
                }
                else if (bookingMonth.year * 12 + bookingMonth.month <
                    fy * 12 + 4) {
                    // Collected before this fiscal year opened — already sitting in deferred.
                    // Deferred revenue is an accounting figure, so it is stated in base.
                    deferredOpening += depositInBase;
                }
                // Balance payments are SPREAD, not a single lump.
                //
                // The model used to land every balance in one month — the due date —
                // which is why the table showed money arriving in two or three months
                // a year and nothing in the rest. In reality students pay across a
                // range, with the bulk inside the last 60 days. A single lump gets
                // the annual total right and the month wrong, and for a cash forecast
                // the month is the whole point.
                //
                // `balanceCurve` is shares by months before departure, same unit as
                // the booking curve. With none set, it degrades to exactly the old
                // behaviour — one lump on the due date, day-precise — so a saved
                // model that predates this keeps its numbers until someone opts in.
                for (const bp of balancePoints) {
                    const balanceMonth = bp.monthsBefore === null
                        ? shiftDays(program.startDate, -rules.balanceDueDaysBeforeDeparture)
                        : addMonths(departure.year, departure.month, -bp.monthsBefore);
                    const balanceSlot = dateToHorizonSlot(fy, balanceMonth.year, balanceMonth.month, horizon);
                    const balanceCash = paxAtThisPoint * balance * bp.share;
                    const balanceInBase = balanceCash * receiptRate;
                    if (balanceSlot !== null) {
                        months[balanceSlot].balancesIn += balanceInBase;
                        addSeasonReceipt(months[balanceSlot], program.season, balanceInBase);
                        splitReceiptByCurrency(months[balanceSlot], balanceCash, receiptRate, receiptsAreFx, nzdShare);
                    }
                    else if (balanceMonth.year * 12 + balanceMonth.month < fy * 12 + 4) {
                        deferredOpening += balanceInBase;
                    }
                }
            }
        }
        /* ---- cash out ---- */
        const phasing = normalise(assumptions.costPhasing.offsets);
        for (const point of phasing) {
            const costMonth = addMonths(departure.year, departure.month, point.monthOffset);
            const slot = dateToHorizonSlot(fy, costMonth.year, costMonth.month, horizon);
            if (slot !== null) {
                months[slot].programCostsOut += totalCost * point.share;
            }
        }
        /* ---- recognition ----
         *
         * The deadline is the departure month. Income for a season arrives over
         * the months up to and including it, and the ENGINE does not model that
         * run-up — it places the whole season at the deadline and leaves the
         * shape to the books.
         *
         * That is deliberate and it is stated rather than hidden: the engine
         * cannot see the P&L (it is pure, and it runs in the browser during an
         * edit), so it has no way to know what has already been recognised. The
         * surplus view does know, and it is where the netting happens — closed
         * months carry the books, and only the unrecognised remainder is left
         * to land at the deadline. The engine's job is to say WHEN a season must
         * be complete by; the surplus view's job is to say how much of it is
         * still outstanding. */
        const rec = recognitionMonthFor(program);
        const recSlot = dateToHorizonSlot(fy, rec.year, rec.month, horizon);
        if (recSlot !== null) {
            months[recSlot].recognisedRevenue += grossRevenue;
            // Named so the surplus view can net a part-recognised season against
            // its own deadline rather than against a month.
            months[recSlot].recognitionDeadlineFor ??= [];
            months[recSlot].recognitionDeadlineFor.push({
                programId: program.id, name: program.name, season: program.season,
                grossRevenue, departs: program.startDate,
            });
        }
        else if (rec.year * 12 + rec.month < fy * 12 + 4) {
            // Recognised in a prior year — its cash is not this year's deferred balance.
            deferredOpening -= grossRevenue;
            // This is legitimate for a genuinely earlier cohort and a serious
            // error otherwise: the revenue vanishes from the year and deferred
            // goes negative by the same amount. Either way nobody should have to
            // infer it from a negative balance.
            warnings.push(`${program.name} departs ${program.startDate}, so its revenue is fully recognised by ${rec.year}-${String(rec.month).padStart(2, "0")} — before this fiscal year opened. None of it is in the year. Check the departure date.`);
        }
        else {
            warnings.push(`${program.name} departs ${program.startDate}, so its revenue is recognised by ${rec.year}-${String(rec.month).padStart(2, "0")} — past the end of the table, so it is not counted here.`);
        }
        contributions.push({
            programId: program.id,
            name: program.name,
            season: program.season,
            pax,
            grossRevenue,
            totalCost,
            contribution: grossRevenue - totalCost,
            recognitionIndex: recSlot,
        });
    }
    /* ---- overheads, capital, tax ----
     *
     * These are twelve entered figures, one per fiscal month. Past the fiscal
     * year the same twelve repeat: April 2027 takes April 2026's overhead.
     *
     * WHY REPEAT RATHER THAN LEAVE BLANK
     * ----------------------------------
     * Blank would be the purer choice and it produces a worse lie. The tail has
     * no FY27/28 programs, so no student money arrives in it. If overheads were
     * also blank the tail would show net zero every month — a flat line that
     * reads as "nothing happens", when what is actually true is "rent and
     * salaries keep going out and we have not entered next year's programs".
     * The first is invisible; the second is a prompt to go and enter them.
     *
     * Wages and rent continuing is a much smaller assumption than any guess at
     * next year's enrolments, which is why this repeats and programs do not.
     * Every month it applies to is flagged carriedForward, and the page says so
     * above the table.
     *
     * WHICH TWELVE GET REPEATED
     * -------------------------
     * `monthlyOverheads` is resolved per month: a closed month holds what was
     * actually spent, an open one holds the budget. Repeating THAT into the
     * runway would carry actuals forward — April 2028 inheriting what April
     * 2026 happened to cost — and the problem compounds as the year closes,
     * until by March the whole repeated year is history rather than plan.
     *
     * `monthlyOverheadsForward` is the same twelve resolved without the
     * actuals: budget where there is one, typed where there is not. The runway
     * repeats that, so a month that has not happened is costed the way every
     * other month that has not happened is costed. It falls back to the
     * resolved array for an older caller that does not send it. */
    const forwardBasis = Array.isArray(assumptions.monthlyOverheadsForward)
        ? assumptions.monthlyOverheadsForward
        : assumptions.monthlyOverheads;
    for (let slot = 0; slot < months.length; slot++) {
        const source = slot % 12;
        const beyond = slot >= 12;
        months[slot].overheads = (beyond ? forwardBasis[source] : assumptions.monthlyOverheads[source]) ?? 0;
        // Capital and tax have no budget feed — they are typed figures only —
        // so they repeat as they are. Named here rather than left implicit,
        // because "everything past actuals comes from the budget" is true of
        // overheads and not yet true of these.
        months[slot].capital = assumptions.monthlyCapital[source] ?? 0;
        months[slot].tax = assumptions.monthlyTax[source] ?? 0;
        months[slot].carriedForward = beyond;
        months[slot].overheadCarriedFrom = beyond
            ? (assumptions.monthlyOverheadsForwardSources?.[source] ?? "typed")
            : null;
    }
    /* ---- roll forward: two accounts, converting only when NZD runs short ---- */
    const baseCur = assumptions.baseCurrency;
    const fxCur = assumptions.settlementCurrency;
    const rate = assumptions.fxRates[fxCur] ?? 1;
    const buffer = assumptions.baseMinimumBuffer ?? 0;
    let fxBalance = assumptions.openingBalances?.[fxCur] ?? 0;
    let baseBalance = assumptions.openingBalances?.[baseCur] ?? 0;
    let deferred = deferredOpening;
    if (!(rate > 0)) {
        warnings.push(`No usable ${fxCur}/${baseCur} rate — conversions are disabled and the ${baseCur} position will look worse than it is.`);
    }
    // Months at or before this are replaced with what actually happened. Null or
    // absent means the whole year is forecast.
    const actualsThrough = assumptions.actualsThroughMonth || null;
    const isClosed = (key) => Boolean(actualsThrough) && key <= actualsThrough;

    for (const row of months) {
        row.cashIn = row.depositsIn + row.balancesIn + row.revenueIn;
        row.cashOut = row.programCostsOut + row.overheads + row.capital + row.tax;
        row.net = row.cashIn - row.cashOut;
        // All outflows are settled in base. Program costs already converted above.
        row.baseOut = row.cashOut;
        row.fxOpening = fxBalance;
        row.baseOpening = baseBalance;
        row.opening = baseBalance + fxBalance * rate;

        const actual = isClosed(row.key) ? actualsByMonth[row.key] : null;

        if (actual) {
            /* ---- a closed month: what happened, not what was predicted ----
             *
             * Bank Summary gives received, spent and closing per bank account.
             * That is enough for the balances and the totals, and NOT enough to
             * split spend across program costs / overheads / capital, or to say
             * how much of the NZD received was a conversion rather than a
             * customer payment. Those rows keep their forecast values and are
             * marked as such rather than being given invented precision.
             *
             * Crucially the closing balances become the next month's opening, so
             * the remaining forecast re-bases onto reality instead of carrying a
             * stale predicted balance forward for the rest of the year. */
            const b = actual.byCurrency || {};
            const baseA = b[baseCur] || { received: 0, spent: 0, closing: null };
            const fxA = b[fxCur] || { received: 0, spent: 0, closing: null };

            row.isActual = true;

            /* TRANSACTION DETAIL IF WE HAVE IT, BANK SUMMARY IF WE DO NOT.
             *
             * These two sources are NOT in the same units, which is the trap
             * that made the treasury block wrong for months. Xero's Bank Summary
             * reports EVERY account converted to the base currency, so the
             * bucket labelled USD held New Zealand dollars — and this engine
             * then multiplied it by the planning rate a second time. August's
             * total position read 370,307 where roughly 204,500 was right.
             *
             * The transaction detail is in each account's OWN currency, which is
             * what the rest of this engine assumes, and it excludes transfers
             * between the organisation's own accounts — so cash in stops
             * counting the 1.08m that June moved between nineteen accounts.
             *
             * Proven, not assumed: with transfers included the detail reconciles
             * to the summary exactly in NZD, and the ratio for USD and AUD is
             * the day's FX rate to four significant figures. */
            const tx = actual.tx;
            const txBase = tx?.byCurrency?.[baseCur] || { in: 0, out: 0 };
            const txFx = tx?.byCurrency?.[fxCur] || { in: 0, out: 0 };
            const trBase = tx?.transfersByCurrency?.[baseCur] || { in: 0, out: 0 };
            const trFx = tx?.transfersByCurrency?.[fxCur] || { in: 0, out: 0 };
            const usingTx = Boolean(tx) && !tx.truncated;

            row.usesTransactionDetail = usingTx;
            row.actualSource = usingTx
                ? (tx.source || "Xero transactions")
                : (actual.source || "Xero Bank Summary");

            if (usingTx) {
                // Business cash only. Own-account transfers are excluded here and
                // applied to the balances separately, below.
                row.baseIn = txBase.in;
                row.fxIn = txFx.in;
                row.baseOut = txBase.out;
                row.fxOut = txFx.out;
                row.grossIncludesTransfers = false;

                // Now derivable, and real: the USD leg of a conversion is a
                // transfer OUT of a USD account, and the NZD that arrived is the
                // matching transfer IN. A bank summary could never tell these
                // from a customer payment.
                row.fxConverted = trFx.out;
                row.baseFromConversion = trBase.in;
            } else {
                row.baseIn = baseA.received || 0;
                row.fxIn = fxA.received || 0;
                row.baseOut = baseA.spent || 0;
                row.fxOut = fxA.spent || 0;
                // GROSS movements: a conversion appears as both money out of the
                // fx account and money into the base account, so both rows are
                // overstated by the amount converted. Net movement and the
                // balances are unaffected, because it inflates both sides.
                row.grossIncludesTransfers = row.baseIn > 0 && row.fxOut > 0;
                // WHY the summary is being used, so the warning can say what to
                // do rather than only what is wrong. "No detail stored" and "the
                // detail came back short" need different answers, and a warning
                // that describes a problem without naming its remedy just makes
                // someone ask again.
                row.actualsFallbackReason = tx ? "truncated" : "no-transaction-detail";
                row.fxConverted = null;
                row.baseFromConversion = null;
                // The summary is base-currency throughout, so its fx figures are
                // ALREADY in base and must not be converted again.
                row.fxFiguresAreBase = true;
            }

            // Headline rows, base-stated, so the column still adds up. The fx
            // side is converted only when it is genuinely in the fx currency.
            const fxToBase = row.fxFiguresAreBase ? 1 : rate;
            row.cashIn = row.baseIn + row.fxIn * fxToBase;
            row.cashOut = row.baseOut + row.fxOut * fxToBase;
            row.net = row.cashIn - row.cashOut;

            // A bank summary's own four columns must reconcile: closing has to
            // equal opening plus received minus spent. It is the same statement
            // read four ways, so a mismatch is never a real-world difference —
            // it means the report was not parsed correctly.
            //
            // This check exists because the live dashboard showed a closing
            // balance of exactly zero for five consecutive months while the same
            // record reported six figures of receipts. Trusting that zero
            // re-based the entire remaining forecast onto a balance that never
            // existed, and the variance row read as half a million to the good.
            //
            // Where the columns disagree, the derived figure wins: opening,
            // received and spent all looked right, and only closing was wrong.
            // Either way it is said out loud rather than shown as a confident
            // number.
            // FX GAIN IS PART OF THE IDENTITY, not noise.
            //
            // A foreign-currency bank account's closing balance is opening plus
            // receipts less payments PLUS the revaluation Xero books when the
            // rate moves. Leaving it out made every USD month fail this check by
            // the size of the revaluation even once the columns were read
            // correctly — and a guard that cries wolf every month is a guard
            // nobody reads. Base-currency accounts carry zero here, so the
            // identity is unchanged for them.
            const reconcile = (cur, side, running, inn, out) => {
                const stored = side.closing;
                const fxGain = Number.isFinite(side.fxGain) ? side.fxGain : 0;
                const derived = (Number.isFinite(side.opening) ? side.opening : running)
                    + inn - out + fxGain;
                if (stored === null || stored === undefined) return derived;
                // Tolerate cents, not thousands.
                const tolerance = Math.max(1, Math.abs(inn) * 0.005);
                if (Math.abs(stored - derived) > tolerance) {
                    const fxNote = fxGain
                        ? ` (including ${Math.round(fxGain).toLocaleString("en-NZ")} of revaluation)`
                        : "";
                    warnings.push(`${row.label}: the ${cur} bank summary does not add up — closing ${Math.round(stored).toLocaleString("en-NZ")} against opening plus receipts less payments of ${Math.round(derived).toLocaleString("en-NZ")}${fxNote}. The report is not being read correctly, so this month's balances cannot be trusted. Unlock it until this is fixed.`);
                    return derived;
                }
                return stored;
            };

            if (usingTx) {
                /* Chain the balances in each account's OWN currency.
                 *
                 * Business cash plus the organisation's own transfers: a
                 * conversion is not business cash, but it absolutely moves the
                 * balance, so it belongs here and nowhere else.
                 *
                 * The bank summary is still checked against this, but it cannot
                 * be compared directly — it is base-currency — so it is
                 * converted back at the rate the two views imply for that month.
                 * That rate is measured, not assumed: it comes from dividing the
                 * same month's summary by the same month's detail. */
                baseBalance += (row.baseIn + trBase.in) - (row.baseOut + trBase.out);
                fxBalance += (row.fxIn + trFx.in) - (row.fxOut + trFx.out);

                /* TWO DIFFERENT CHECKS, because the two currencies are not
                 * comparable in the same way.
                 *
                 * The base currency converts at 1, so its transaction-derived
                 * balance and the summary's closing balance can be compared
                 * directly and any difference is real.
                 *
                 * A foreign account cannot be checked that way. The summary is
                 * base-currency, so comparing it to a dollar balance needs a
                 * rate, and the only rate available is the one implied by the
                 * month's FLOWS — an average over the month. Applying an
                 * average-of-month rate to a point-in-time balance produces a
                 * difference that is pure arithmetic and grows with the balance.
                 * That is exactly what happened: every USD month reported a
                 * mismatch of tens of thousands while the data was fine, and the
                 * one real finding — a constant offset in NZD — sat in the
                 * middle of the noise.
                 *
                 * So the foreign side is checked on its FLOWS, where no
                 * point-in-time conversion is involved. */
                const storedBase = baseA.closing;
                if (storedBase !== null && storedBase !== undefined) {
                    const drift = baseBalance - storedBase;
                    if (Math.abs(drift) > Math.max(50, Math.abs(storedBase) * 0.002)) {
                        // Name the opening this chain started from, and where it
                        // came from. A constant drift IS an opening-balance
                        // error, and the next question is always "which figure
                        // did it use" — so answer it in the warning rather than
                        // making someone go and look.
                        const meta = assumptions.openingsMeta;
                        const first = months[0];
                        const openingNote = meta
                            ? ` This chain started from a ${baseCur} opening of ${Math.round(first.baseOpening).toLocaleString("en-NZ")} (${meta.source}${
                                meta.fromXero?.[baseCur] !== undefined && meta.source !== "xero"
                                    ? `; Xero's April opening is ${Math.round(meta.fromXero[baseCur]).toLocaleString("en-NZ")}`
                                    : ""}).`
                            : "";
                        warnings.push(`${row.label}: the ${baseCur} balance from transactions (${Math.round(baseBalance).toLocaleString("en-NZ")}) does not match the bank summary (${Math.round(storedBase).toLocaleString("en-NZ")}), a difference of ${Math.round(drift).toLocaleString("en-NZ")}. The same difference in every month points at the opening balance; a changing one points at missing transactions.${openingNote}`);
                    }
                }

                /* JUDGE HERE, do not read a stored judgement.
                 *
                 * `ties` was being computed when the month was FETCHED and baked
                 * into the blob. So widening the tolerance from 1% to 6% changed
                 * nothing on screen: every stored month still carried
                 * `ties: false` from the old threshold, and would have kept
                 * carrying it until someone refetched a year of data.
                 *
                 * The gap percentages are DATA — measured, fixed, worth caching.
                 * Whether that gap is acceptable is a JUDGEMENT, and a judgement
                 * belongs where it can be changed without a refetch. Same
                 * mistake as caching a parser's output: fine until the rule
                 * changes, and then the cache is the last thing holding the old
                 * answer. */
                const FLOW_TOLERANCE_PCT = 6;
                for (const cur of [baseCur, fxCur]) {
                    const flow = tx.flowCheck?.[cur];
                    const gapsKnown = flow && Number.isFinite(flow.inGapPct) && Number.isFinite(flow.outGapPct);
                    const tiesNow = gapsKnown
                        ? flow.inGapPct <= FLOW_TOLERANCE_PCT && flow.outGapPct <= FLOW_TOLERANCE_PCT
                        : flow?.ties;
                    if (flow && tiesNow === false) {
                        warnings.push(`${row.label}: the ${cur} transactions are ${flow.inGapPct}% out on receipts and ${flow.outGapPct}% on payments against the bank summary. Beyond what intra-month rate movement explains, so a source may be missing — check with Reconcile ${row.label.split(" ")[0]}.`);
                    }
                }

                if (tx.transferLegs && tx.transferLegs.complete === false) {
                    warnings.push(`${row.label}: ${tx.transferLegs.transfers - tx.transferLegs.bothPresent} of ${tx.transferLegs.transfers} transfers between your own accounts are missing a leg, worth ${Math.round(tx.transferLegs.missingAmount).toLocaleString("en-NZ")}. Balances for this month may be wrong by that amount.`);
                }
            } else {
                baseBalance = reconcile(baseCur, baseA, baseBalance, row.baseIn, row.baseOut);
                fxBalance = reconcile(fxCur, fxA, fxBalance, row.fxIn, row.fxOut);
            }

            if (tx?.truncated) {
                warnings.push(`${row.label}: Xero returned more transactions than were read, so this month is incomplete. The bank summary is being used instead.`);
            }
        }
        else {
            // Receipts land first, then the month's payments are made.
            fxBalance += row.fxIn;
            baseBalance += row.baseIn - row.baseOut;
            // Convert only what is needed to restore the buffer, and only as much as
            // there is to convert. Anything still short stays short — that shortfall is
            // the number worth seeing, so it is never papered over with a plug.
            let converted = 0;
            if (rate > 0 && baseBalance < buffer && fxBalance > 0) {
                const baseNeeded = buffer - baseBalance;
                const fxRequired = baseNeeded / rate;
                converted = Math.min(fxRequired, fxBalance);
                fxBalance -= converted;
                baseBalance += converted * rate;
            }
            row.fxConverted = converted;
            row.baseFromConversion = converted * rate;
        }

        row.fxClosing = fxBalance;
        row.baseClosing = baseBalance;
        // When a closed month fell back to the bank summary, fxBalance is
        // already base-currency and must not be converted a second time. That
        // double conversion is what put August's total position 166,000 high.
        row.closing = baseBalance + fxBalance * (row.fxFiguresAreBase ? 1 : rate);

        // Deferred revenue is an accounting balance, and a bank summary cannot
        // produce one. In a closed month `baseIn`/`fxIn` are GROSS bank
        // movements, which include this company moving its own money from the
        // USD account to the NZD account. Feeding those in compounded the
        // double count every month — the balance reached 2,951,924 by August on
        // real data, which is not a number that means anything.
        //
        // So the chain always runs on forecast receipts. The row is already
        // rendered as still-forecast in closed months, and now the figure
        // matches that label. Reading the real balance would mean taking the
        // deferred revenue liability off the Balance Sheet, which is a separate
        // job from anything the bank summary can answer.
        deferred += row.depositsIn + row.balancesIn + row.revenueIn - row.recognisedRevenue;
        row.deferredRevenueBalance = deferred;
    }

    // A month marked closed with no stored figures is a silent hole — the row
    // would quietly show forecast while the header claims actual.
    if (actualsThrough) {
        const missing = months
            .filter((m) => isClosed(m.key) && !actualsByMonth[m.key])
            .map((m) => m.label);
        if (missing.length) {
            warnings.push(`Locked as actual but no Xero figures stored for ${missing.join(", ")} — those months are still showing forecast. Run the Xero sync.`);
        }
        // Belt and braces: the UI will not offer an unfinished month, but the
        // lock is stored data and could be set by an older client or a direct
        // POST. A part-month shown as actual understates the month AND re-bases
        // every month after it onto a balance that is days old.
        const gross = months.filter((m) => m.grossIncludesTransfers).map((m) => m.label);
        if (gross.length) {
            // The remedy depends on why the detail is absent, and the difference
            // matters: one is a button, the other is a bug.
            const missing = months.filter(
                (m) => m.grossIncludesTransfers && m.actualsFallbackReason === "no-transaction-detail").length;
            const remedy = missing
                ? ` The transaction detail that fixes this has not been pulled for ${missing === gross.length ? "these months" : "some of these months"} — run Diagnostics → Refresh Xero data now.`
                : ` Xero returned more transactions than could be read for ${gross.length === 1 ? "this month" : "these months"}, so the summary is being used instead.`;
            warnings.push(`Cash in and cash out for ${gross.join(", ")} are gross bank movements: a currency conversion shows as both money out of ${fxCur} and money into ${baseCur}, so both rows are overstated by the amount converted. Net movement and the balances are unaffected.${remedy}`);
        }
        const partial = months
            .filter((m) => isClosed(m.key) && actualsByMonth[m.key]?.partial)
            .map((m) => m.label);
        if (partial.length) {
            warnings.push(`${partial.join(", ")} is locked as actual but the month has not finished — the Xero figures cover part of it only, so the total is understated and every month after it is re-based on it.`);
        }
    }
    /* EVERY HEADLINE JUDGEMENT IS MADE ON THE FISCAL YEAR, NOT THE HORIZON.
     *
     * The tail has no programs in it, so its cash-out is real and its cash-in is
     * zero by construction. Let the worst-position search run over the whole
     * horizon and it will ALWAYS find its answer in the final tail month, every
     * month, for the rest of time — a number that measures nothing but the
     * absence of next year's programs, dressed as a liquidity warning.
     *
     * That is the sort of alarm that trains people to ignore alarms. So the
     * fiscal year answers "how bad does it get", and the tail gets its own
     * plainly-labelled caveat lower down. */
    const fyMonths = months.slice(0, 12);
    const lowest = fyMonths.reduce((min, r) => (r.closing < min.closing ? r : min), fyMonths[0]);
    const lowestBase = fyMonths.reduce((min, r) => (r.baseClosing < min.baseClosing ? r : min), fyMonths[0]);
    if (lowestBase.baseClosing < 0) {
        const first = fyMonths.find((m) => m.baseClosing < 0);
        warnings.push(`${baseCur} account goes negative in ${first.label} — worst ${Math.round(lowestBase.baseClosing).toLocaleString("en-NZ")} in ${lowestBase.label}, after converting everything available.`);
    }
    else if (fyMonths.some((m) => m.baseClosing < buffer)) {
        const first = fyMonths.find((m) => m.baseClosing < buffer);
        warnings.push(`${baseCur} dips below the ${Math.round(buffer).toLocaleString("en-NZ")} buffer in ${first.label}.`);
    }
    const tail = months.slice(12);
    const hasProgramMoney = (m) => m.cashIn !== 0 || m.programCostsOut !== 0;
    const tailHasPrograms = tail.some(hasProgramMoney);

    /* WHERE THE ENTERED DATA ACTUALLY RUNS OUT.
     *
     * A single "does the tail have programs" flag was enough when the tail was
     * five months. It is not enough now it spans two years: enter FY27/28 and
     * the flag flips true while April to August 2028 are still empty, so the
     * caveat disappears from exactly the months that still need it.
     *
     * What matters is the TRAILING run of empty months — the point past which
     * nothing is entered — because everything after it is a balance falling on
     * missing inputs. Gaps in the middle are left alone: a quiet month between
     * two seasons is a real forecast, not an absence. */
    let emptyFromIndex = months.length;
    for (let i = months.length - 1; i >= 12; i--) {
        if (hasProgramMoney(months[i])) break;
        emptyFromIndex = i;
    }
    const emptyFrom = emptyFromIndex < months.length ? months[emptyFromIndex] : null;
    if (emptyFrom) {
        const n = months.length - emptyFromIndex;
        warnings.push(`${emptyFrom.label} onward has no programs entered — ${n} month${n === 1 ? "" : "s"} showing overheads going out and no student money coming in. The balance falling through them is the gap in the inputs, not a forecast. Year totals and the warnings above cover the fiscal year only.`);
    }
    const unconverted = fyMonths[11].fxClosing;
    if (unconverted > 0) {
        warnings.push(`${Math.round(unconverted).toLocaleString("en-NZ")} ${fxCur} is still unconverted at 31 March, valued here at ${rate.toFixed(4)}. A 5c move in the rate changes that by ${Math.round(unconverted * 0.05).toLocaleString("en-NZ")} ${baseCur}.`);
    }
    const curveSum = assumptions.defaultPaymentRules.bookingCurve.reduce((s, p) => s + p.share, 0);
    if (Math.abs(curveSum - 1) > 0.001) {
        warnings.push(`Booking curve sums to ${(curveSum * 100).toFixed(1)}% — normalised to 100% for the forecast.`);
    }
    return {
        fiscalYearStartYear: fy,
        months,
        // The shape of the table, so the page does not have to re-derive it and
        // get a different answer. fiscalYearMonths is always 12 and is where
        // every total and warning comes from; anything past it is runway.
        horizon: {
            length: months.length,
            fiscalYearMonths: 12,
            beyondFiscalYear: Math.max(0, months.length - 12),
            lastFiscalMonth: fyMonths[11].key,
            lastMonth: months[months.length - 1].key,
            // The tail exists to show runway, and right now it shows runway
            // with no programs in it. Naming that here means every consumer
            // gets the caveat, not just the one that remembered to add it.
            tailHasPrograms,
            // The month from which nothing is entered, and how many months that
            // is. Null once programs reach the end of the horizon.
            emptyFromKey: emptyFrom?.key ?? null,
            emptyFromLabel: emptyFrom?.label ?? null,
            emptyMonths: emptyFrom ? months.length - emptyFromIndex : 0,
        },
        programs: contributions,
        totals: {
            // Fiscal year only. The horizon is longer now, and a year total
            // that quietly included six months of the next one would be wrong
            // in a way nobody would catch by looking at it.
            cashIn: fyMonths.reduce((s, m) => s + m.cashIn, 0),
            cashOut: fyMonths.reduce((s, m) => s + m.cashOut, 0),
            receiptsBySeason: fyMonths.reduce((acc, m) => {
                for (const [season, v] of Object.entries(m.receiptsBySeason)) {
                    acc[season] = (acc[season] || 0) + v;
                }
                return acc;
            }, {}),
            recognisedRevenue: fyMonths.reduce((s, m) => s + m.recognisedRevenue, 0),
            // Cash collected before 1 April for programs departing inside this
            // year. Exposed because when the deferred row misbehaves this is the
            // first place to look, and it is otherwise invisible.
            deferredOpening,
            closingBalance: fyMonths[11].closing,
            lowestClosing: lowest.closing,
            lowestMonth: lowest.label,
            fxConverted: fyMonths.reduce((s, m) => s + m.fxConverted, 0),
            baseFromConversion: fyMonths.reduce((s, m) => s + m.baseFromConversion, 0),
            lowestBaseClosing: lowestBase.baseClosing,
            lowestBaseMonth: lowestBase.label,
            planningRate: rate,
            actualMonths: months.filter((m) => m.isActual).length,
            actualsThroughMonth: assumptions.actualsThroughMonth || null,
        },
        warnings,
    };
}
