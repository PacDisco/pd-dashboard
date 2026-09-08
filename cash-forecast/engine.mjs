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
 *   RECOGNITION when revenue moves from deferred to sales — September for Fall,
 *               January for Spring, June for Summer, being the month before each
 *               season starts. This drives the P&L view and reconciles to Xero,
 *               where the gap between the two sits in deferred revenue.
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
 * The month a program's revenue is recognised in: the most recent occurrence of
 * the season's recognition month strictly before the program starts.
 *
 * A Fall program departing October 2026 recognises in September 2026. One
 * departing December 2026 also recognises in September 2026 — same season, same
 * recognition event.
 */
export function recognitionMonthFor(program, recognitionMonths) {
    const target = recognitionMonths[program.season];
    const start = parseISODate(program.startDate);
    // Walk back from the month before departure until the month-of-year matches.
    for (let back = 1; back <= 12; back++) {
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
export function buildForecast(assumptions) {
    const fy = assumptions.fiscalYearStartYear;
    const warnings = [];
    const months = Array.from({ length: 12 }, (_, slot) => {
        const { year, month } = fiscalSlotToDate(fy, slot);
        return {
            key: monthKey(year, month),
            label: `${MONTH_LABELS[slot]} ${String(year).slice(2)}`,
            year,
            month,
            depositsIn: 0,
            balancesIn: 0,
            cashIn: 0,
            programCostsOut: 0,
            overheads: 0,
            capital: 0,
            tax: 0,
            cashOut: 0,
            net: 0,
            fxOpening: 0, fxIn: 0, fxConverted: 0, fxClosing: 0,
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
        const grossRevenue = pax * priceInBase;
        const totalCost = fixedCost + variableCost * pax;
        const deposit = Math.min(rules.deposit, price);
        if (rules.deposit > price) {
            warnings.push(`${program.name}: deposit exceeds the program price — capped at the price.`);
        }
        const balance = price - deposit;
        /* ---- cash in ---- */
        const curve = normalise(rules.bookingCurve);
        const departure = parseISODate(program.startDate);
        for (const point of curve) {
            const paxAtThisPoint = pax * point.share;
            // Deposits land in the month the booking is made.
            const bookingMonth = addMonths(departure.year, departure.month, -point.monthsBefore);
            const bookingSlot = dateToFiscalSlot(fy, bookingMonth.year, bookingMonth.month);
            const depositCash = paxAtThisPoint * deposit;
            const depositInBase = depositCash * receiptRate;
            if (bookingSlot !== null) {
                // Headline rows are stated in base currency so they can be added up.
                // The treasury rows below stay in the currency actually received.
                months[bookingSlot].depositsIn += depositInBase;
                if (receiptsAreFx)
                    months[bookingSlot].fxIn += depositCash;
                else
                    months[bookingSlot].baseIn += depositCash;
            }
            else if (bookingMonth.year * 12 + bookingMonth.month <
                fy * 12 + 4) {
                // Collected before this fiscal year opened — already sitting in deferred.
                // Deferred revenue is an accounting figure, so it is stated in base.
                deferredOpening += depositInBase;
            }
            // Balances all fall due on the same date regardless of when booked.
            const balanceMonth = shiftDays(program.startDate, -rules.balanceDueDaysBeforeDeparture);
            const balanceSlot = dateToFiscalSlot(fy, balanceMonth.year, balanceMonth.month);
            const balanceCash = paxAtThisPoint * balance;
            const balanceInBase = balanceCash * receiptRate;
            if (balanceSlot !== null) {
                months[balanceSlot].balancesIn += balanceInBase;
                if (receiptsAreFx)
                    months[balanceSlot].fxIn += balanceCash;
                else
                    months[balanceSlot].baseIn += balanceCash;
            }
            else if (balanceMonth.year * 12 + balanceMonth.month < fy * 12 + 4) {
                deferredOpening += balanceInBase;
            }
        }
        /* ---- cash out ---- */
        const phasing = normalise(assumptions.costPhasing.offsets);
        for (const point of phasing) {
            const costMonth = addMonths(departure.year, departure.month, point.monthOffset);
            const slot = dateToFiscalSlot(fy, costMonth.year, costMonth.month);
            if (slot !== null) {
                months[slot].programCostsOut += totalCost * point.share;
            }
        }
        /* ---- recognition ---- */
        const rec = recognitionMonthFor(program, assumptions.recognitionMonths);
        const recSlot = dateToFiscalSlot(fy, rec.year, rec.month);
        if (recSlot !== null) {
            months[recSlot].recognisedRevenue += grossRevenue;
        }
        else if (rec.year * 12 + rec.month < fy * 12 + 4) {
            // Recognised in a prior year — its cash is not this year's deferred balance.
            deferredOpening -= grossRevenue;
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
    /* ---- overheads, capital, tax ---- */
    for (let slot = 0; slot < 12; slot++) {
        months[slot].overheads = assumptions.monthlyOverheads[slot] ?? 0;
        months[slot].capital = assumptions.monthlyCapital[slot] ?? 0;
        months[slot].tax = assumptions.monthlyTax[slot] ?? 0;
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
    for (const row of months) {
        row.cashIn = row.depositsIn + row.balancesIn;
        row.cashOut = row.programCostsOut + row.overheads + row.capital + row.tax;
        row.net = row.cashIn - row.cashOut;
        // All outflows are settled in base. Program costs already converted above.
        row.baseOut = row.cashOut;
        row.fxOpening = fxBalance;
        row.baseOpening = baseBalance;
        row.opening = baseBalance + fxBalance * rate;
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
        row.fxClosing = fxBalance;
        row.baseClosing = baseBalance;
        row.closing = baseBalance + fxBalance * rate;
        // Deferred revenue is an accounting balance, stated in base currency.
        deferred += row.fxIn * rate + row.baseIn - row.recognisedRevenue;
        row.deferredRevenueBalance = deferred;
    }
    const lowest = months.reduce((min, r) => (r.closing < min.closing ? r : min), months[0]);
    const lowestBase = months.reduce((min, r) => (r.baseClosing < min.baseClosing ? r : min), months[0]);
    if (lowestBase.baseClosing < 0) {
        const first = months.find((m) => m.baseClosing < 0);
        warnings.push(`${baseCur} account goes negative in ${first.label} — worst ${Math.round(lowestBase.baseClosing).toLocaleString("en-NZ")} in ${lowestBase.label}, after converting everything available.`);
    }
    else if (months.some((m) => m.baseClosing < buffer)) {
        const first = months.find((m) => m.baseClosing < buffer);
        warnings.push(`${baseCur} dips below the ${Math.round(buffer).toLocaleString("en-NZ")} buffer in ${first.label}.`);
    }
    const unconverted = months[11].fxClosing;
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
        programs: contributions,
        totals: {
            cashIn: months.reduce((s, m) => s + m.cashIn, 0),
            cashOut: months.reduce((s, m) => s + m.cashOut, 0),
            recognisedRevenue: months.reduce((s, m) => s + m.recognisedRevenue, 0),
            closingBalance: months[11].closing,
            lowestClosing: lowest.closing,
            lowestMonth: lowest.label,
            fxConverted: months.reduce((s, m) => s + m.fxConverted, 0),
            baseFromConversion: months.reduce((s, m) => s + m.baseFromConversion, 0),
            lowestBaseClosing: lowestBase.baseClosing,
            lowestBaseMonth: lowestBase.label,
            planningRate: rate,
        },
        warnings,
    };
}
