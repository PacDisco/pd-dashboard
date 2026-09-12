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
export function buildForecast(assumptions, actualsByMonth = {}) {
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
                const slot = dateToFiscalSlot(fy, month.year, month.month);
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
                const bookingSlot = dateToFiscalSlot(fy, bookingMonth.year, bookingMonth.month);
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
                    const balanceSlot = dateToFiscalSlot(fy, balanceMonth.year, balanceMonth.month);
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
            // This is legitimate for a genuinely earlier cohort and a serious
            // error otherwise: the revenue vanishes from the year and deferred
            // goes negative by the same amount. Either way nobody should have to
            // infer it from a negative balance.
            warnings.push(`${program.name} recognises in ${rec.year}-${String(rec.month).padStart(2, "0")}, before this fiscal year — its revenue is not in the year at all. Check the departure date against the ${program.season} recognition month.`);
        }
        else {
            warnings.push(`${program.name} recognises in ${rec.year}-${String(rec.month).padStart(2, "0")}, after this fiscal year — its revenue falls outside the year shown.`);
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
            row.actualSource = actual.source || "Xero Bank Summary";

            row.baseIn = baseA.received || 0;
            row.fxIn = fxA.received || 0;
            row.baseOut = baseA.spent || 0;
            row.fxOut = fxA.spent || 0;

            // Headline rows, base-stated, so the column still adds up.
            //
            // CAUTION: these are GROSS bank movements, and a USD→NZD conversion
            // appears in both — once as USD spent, once as NZD received. So a
            // month with conversions overstates cash in and cash out by the
            // converted amount. Net movement and the balances are unaffected,
            // because the same figure inflates both sides and cancels.
            //
            // This cannot be fixed from a bank summary: a conversion landing in
            // the NZD account and a student paying into it look identical. It is
            // what the receivable-receipts pull is for. Flagged on the row so the
            // UI can mark it rather than presenting a gross figure as takings.
            row.cashIn = row.baseIn + row.fxIn * rate;
            row.cashOut = row.baseOut + row.fxOut * rate;
            row.net = row.cashIn - row.cashOut;
            row.grossIncludesTransfers = row.baseIn > 0 && row.fxOut > 0;

            // Not derivable from a bank summary — a conversion and a customer
            // payment both look like money arriving in the NZD account.
            row.fxConverted = null;
            row.baseFromConversion = null;

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
            const reconcile = (cur, side, running, inn, out) => {
                const stored = side.closing;
                const derived = (Number.isFinite(side.opening) ? side.opening : running) + inn - out;
                if (stored === null || stored === undefined) return derived;
                // Tolerate cents, not thousands.
                const tolerance = Math.max(1, Math.abs(inn) * 0.005);
                if (Math.abs(stored - derived) > tolerance) {
                    warnings.push(`${row.label}: the ${cur} bank summary does not add up — closing ${Math.round(stored).toLocaleString("en-NZ")} against opening plus receipts less payments of ${Math.round(derived).toLocaleString("en-NZ")}. The report is not being read correctly, so this month's balances cannot be trusted. Unlock it until this is fixed.`);
                    return derived;
                }
                return stored;
            };

            baseBalance = reconcile(baseCur, baseA, baseBalance, row.baseIn, row.baseOut);
            fxBalance = reconcile(fxCur, fxA, fxBalance, row.fxIn, row.fxOut);
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
        row.closing = baseBalance + fxBalance * rate;

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
            warnings.push(`Cash in and cash out for ${gross.join(", ")} are gross bank movements: a currency conversion shows as both money out of ${fxCur} and money into ${baseCur}, so both rows are overstated by the amount converted. Net movement and the balances are unaffected.`);
        }
        const partial = months
            .filter((m) => isClosed(m.key) && actualsByMonth[m.key]?.partial)
            .map((m) => m.label);
        if (partial.length) {
            warnings.push(`${partial.join(", ")} is locked as actual but the month has not finished — the Xero figures cover part of it only, so the total is understated and every month after it is re-based on it.`);
        }
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
            receiptsBySeason: months.reduce((acc, m) => {
                for (const [season, v] of Object.entries(m.receiptsBySeason)) {
                    acc[season] = (acc[season] || 0) + v;
                }
                return acc;
            }, {}),
            recognisedRevenue: months.reduce((s, m) => s + m.recognisedRevenue, 0),
            // Cash collected before 1 April for programs departing inside this
            // year. Exposed because when the deferred row misbehaves this is the
            // first place to look, and it is otherwise invisible.
            deferredOpening,
            closingBalance: months[11].closing,
            lowestClosing: lowest.closing,
            lowestMonth: lowest.label,
            fxConverted: months.reduce((s, m) => s + m.fxConverted, 0),
            baseFromConversion: months.reduce((s, m) => s + m.baseFromConversion, 0),
            lowestBaseClosing: lowestBase.baseClosing,
            lowestBaseMonth: lowestBase.label,
            planningRate: rate,
            actualMonths: months.filter((m) => m.isActual).length,
            actualsThroughMonth: assumptions.actualsThroughMonth || null,
        },
        warnings,
    };
}
