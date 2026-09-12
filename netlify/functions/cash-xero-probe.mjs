// netlify/functions/cash-xero-probe.mjs
//
// A read-only look at what Xero actually returns for one month of receivable
// payments, before any of it is wired into the forecast.
//
// WHY A PROBE RATHER THAN JUST BUILDING IT
// ----------------------------------------
// Two things about the real books cannot be established from documentation:
// whether student invoices carry a program tracking option at all, and what
// those options are called. Guessing produces a table where every figure lands
// in "Unattributed" and nobody can tell whether the parser is wrong or the
// bookkeeping is different from what was assumed. This endpoint answers both
// questions with one call, against the real organisation, changing nothing.
//
// Delete it once receipts are wired in and trusted.
//
//   GET /api/cash-xero-probe?month=2026-08
//
// Admin/operations only, like every other endpoint here.

import { requireCashRole, json } from "./_shared/cash-access.mjs";
import {
  getAccessToken, getConnections, xeroGet, getBankAccountCurrencies,
} from "./_shared/cash-xero.mjs";
import {
  fetchBankTransactions,
  fetchAllPayments,
  fetchBankTransfers,
  summariseSources,
  reconcileToSummary,
} from "./_shared/cash-bank-tx.mjs";
import { loadAssumptions, currentFiscalYear, resolveOpeningBalances } from "./_shared/cash-store.mjs";
import {
  fetchPayments,
  fetchInvoicesByIds,
  attributeReceipts,
} from "./_shared/cash-receipts.mjs";
import { fetchMonthOpex } from "./_shared/cash-opex.mjs";
import { listBudgets, fetchBudget, accountIndex, overheadsFromBudget } from "./_shared/cash-budget.mjs";

/**
 * Describe an object's shape without emitting its contents.
 *
 * The point of the probe is to confirm field names and nesting. Student names,
 * emails and invoice references are not needed for that, and a diagnostic
 * endpoint is no place to accumulate them — so keys are returned, values are
 * not, apart from the handful of non-identifying numeric fields the parser
 * actually reads.
 */
function shapeOf(obj, keep = []) {
  if (!obj || typeof obj !== "object") return null;
  const out = { __keys: Object.keys(obj) };
  for (const k of keep) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * What the bank side actually produced for a month.
 *
 * The forecast shows one number per currency per month; this shows the account
 * rows behind it, the currency each was assigned, and the opening balances the
 * engine started the year from. When the NZD account row reads zero all year,
 * the answer is in exactly one of those three places, and guessing which costs
 * more than one call.
 *
 * Reads the STORED blob, not Xero, so it shows what the forecast is really
 * using rather than what a fresh pull would say.
 */
async function bankReport(fy, month) {
  const { getStore } = await import("@netlify/blobs");
  const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
  const tenantId = latest?.orgs?.[0]?.tenantId;
  if (!tenantId) return { error: "No synced organisation yet." };

  const monthStore = getStore({ name: "cash-xero-months" });
  const record = await monthStore.get(`${tenantId}/${month}`, { type: "json" });
  const assumptions = await loadAssumptions(fy);
  const april = await monthStore.get(`${tenantId}/${fy}-04`, { type: "json" });

  const baseCur = assumptions.baseCurrency || "NZD";
  const fxCur = assumptions.settlementCurrency || "USD";
  const b = record?.byCurrency ?? {};

  return {
    month,
    stored: Boolean(record),
    partial: record?.partial ?? null,
    fetchedAt: record?.fetchedAt ?? null,

    // The rows Xero returned, with the currency each was classified as. If the
    // classification is wrong, every figure downstream is wrong in the same way.
    accounts: (record?.accounts ?? []).map((a) => ({
      name: a.name,
      opening: a.opening,
      received: a.received,
      spent: a.spent,
      closing: a.closing,
    })),
    currenciesFound: Object.keys(b),
    byCurrency: b,

    // The two buckets the engine actually reads, named explicitly, because a
    // missing bucket and a zero bucket look identical in the table.
    engineReads: {
      baseCurrency: baseCur,
      settlementCurrency: fxCur,
      basePresent: Object.prototype.hasOwnProperty.call(b, baseCur),
      fxPresent: Object.prototype.hasOwnProperty.call(b, fxCur),
      baseClosing: b[baseCur]?.closing ?? null,
      fxClosing: b[fxCur]?.closing ?? null,
    },

    openings: resolveOpeningBalances(assumptions, april),
    openingBalanceSource: assumptions.openingBalanceSource ?? "xero",
    actualsThroughMonth: assumptions.actualsThroughMonth ?? null,
  };
}

export default async (req) => {
  const user = await requireCashRole(req, "write", "cash-xero-probe");
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const report = url.searchParams.get("report");
  const month = url.searchParams.get("month");
  // The budget covers the whole year, so it is the one mode that needs no month.
  if (report !== "budget" && !/^\d{4}-\d{2}$/.test(month ?? "")) {
    return json({ error: "Pass ?month=YYYY-MM, e.g. ?month=2026-08" }, 400);
  }

  // ?report=bank needs no new scope — it reads what the sync already stored.
  if (report === "bank") {
    return json(await bankReport(currentFiscalYear(), month));
  }

  // ?report=banktx is the gate on the whole cash-rows rebuild.
  //
  // Before a single figure from the transaction detail reaches the forecast,
  // this answers one question: do Bank Transactions + Payments + Bank Transfers
  // add up to what the Bank Summary says moved? If they do not, a source is
  // missing, and a categoriser built on an incomplete set would produce
  // plausible numbers that are quietly short. The residual is reported per
  // currency rather than hidden behind a pass/fail.
  //
  // Needs accounting.banktransactions.read. Shapes and counts only — no contact
  // names, references or line detail leave this endpoint.
  if (report === "banktx") {
    try {
      const token = await getAccessToken();
      const pinned = (process.env.XERO_TENANTS ?? "")
        .split(",").map((x) => x.trim()).filter(Boolean);
      const all = await getConnections(token);
      const org = (pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all)[0];
      if (!org) return json({ error: "No Xero organisation connected." }, 409);

      const currencyOf = await getBankAccountCurrencies(token, org.tenantId, "NZD");
      const [{ bankTransactions, truncated: txTrunc },
             { payments, truncated: payTrunc },
             transferResult] = await Promise.all([
        fetchBankTransactions(token, org.tenantId, month),
        fetchAllPayments(token, org.tenantId, month),
        fetchBankTransfers(token, org.tenantId, month),
      ]);

      const summarised = summariseSources({
        bankTransactions,
        payments,
        transfers: transferResult.transfers,
        currencyOf,
      });

      // Compared against the SAME stored month the forecast reads, not a fresh
      // pull — so this checks what the dashboard is actually showing.
      const { getStore } = await import("@netlify/blobs");
      const stored = await getStore({ name: "cash-xero-months" })
        .get(`${org.tenantId}/${month}`, { type: "json" });
      const reconciliation = reconcileToSummary(summarised, stored?.byCurrency ?? {});

      // Line items are where the categorisation will have to come from, and
      // whether the LIST endpoint returns them at all decides whether this is
      // one call a month or one call per transaction. Worth knowing now.
      const sampleTx = bankTransactions[0];
      const samplePayment = payments[0];

      return json({
        month,
        organisation: org.tenantName,
        counts: {
          bankTransactions: bankTransactions.length,
          payments: payments.length,
          transfers: transferResult.transfers.length,
          ...summarised.counts,
        },
        truncated: { bankTransactions: txTrunc, payments: payTrunc, transfers: transferResult.truncated },
        transfersEndpoint: transferResult.available
          ? "available"
          : `unavailable: ${transferResult.error ?? "unknown"}`,

        // THE ANSWER. Anything with inTies/outTies false means a source is
        // missing and the rebuild is not safe to proceed on yet.
        reconciliation,
        storedMonthPresent: Boolean(stored),

        // Business movement with the organisation's own transfers taken out —
        // what Cash in and Cash out would become.
        businessMovement: summarised.byCurrency,
        ownTransfers: summarised.transfersByCurrency,

        typesSeen: [...new Set(bankTransactions.map((t) => t?.Type).filter(Boolean))],
        unknownTypes: summarised.unknownTypes,
        bankAccountsSeen: summarised.accountsSeen,

        // Field names only, so the categoriser is written against the real
        // shape instead of the documented one.
        sampleBankTransactionShape: shapeOf(sampleTx, ["Type", "CurrencyCode", "CurrencyRate", "IsReconciled"]),
        bankTransactionHasLineItems: Array.isArray(sampleTx?.LineItems),
        sampleLineItemShape: shapeOf(sampleTx?.LineItems?.[0], ["AccountCode"]),
        samplePaymentShape: shapeOf(samplePayment, ["PaymentType", "CurrencyRate"]),
        samplePaymentAccountShape: shapeOf(samplePayment?.Account, ["Code"]),
      });
    } catch (err) {
      console.error(`[cash-xero-probe banktx] ${err.message}`);
      return json({
        error: err.message,
        hint: "A 403 mentioning scope means accounting.banktransactions.read was not granted — re-consent.",
      }, 502);
    }
  }

  // ?report=opex uses accounting.reports.profitandloss.read, already consented.
  // Checks the P&L parser against a month you can open in Xero side by side,
  // before a single figure of it reaches the forecast.
  if (report === "opex") {
    try {
      const token = await getAccessToken();
      const pinned = (process.env.XERO_TENANTS ?? "")
        .split(",").map((x) => x.trim()).filter(Boolean);
      const all = await getConnections(token);
      const org = (pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all)[0];
      if (!org) return json({ error: "No Xero organisation connected." }, 409);

      const opex = await fetchMonthOpex(token, org.tenantId, month);
      // The raw report too, so a layout that does not match can be seen rather
      // than deduced. Section titles and their row counts are enough.
      const raw = await xeroGet(token, org.tenantId, "Reports/ProfitAndLoss", {
        fromDate: `${month}-01`, toDate: `${month}-28`, standardLayout: "true",
      }).catch(() => null);
      const a = await loadAssumptions(currentFiscalYear());
      const slot = (Number(month.slice(5, 7)) + 8) % 12; // April is slot 0
      return json({
        ...opex,
        organisation: org.tenantName,
        modelOverheads: a.monthlyOverheads?.[slot] ?? null,
        modelCapital: a.monthlyCapital?.[slot] ?? null,
        // The comparison that matters: what the model assumes leaves the bank
        // this month, against what actually did.
        modelTotal: (a.monthlyOverheads?.[slot] ?? 0) + (a.monthlyCapital?.[slot] ?? 0),
        reportTitles: (raw?.Reports?.[0]?.Rows ?? [])
          .map((r) => ({ rowType: r.RowType, title: r.Title ?? null, rows: (r.Rows ?? []).length })),
        differenceVsModel: Math.round(
          opex.cashTotal - ((a.monthlyOverheads?.[slot] ?? 0) + (a.monthlyCapital?.[slot] ?? 0)),
        ),
      });
    } catch (err) {
      console.error(`[cash-xero-probe opex] ${err.message}`);
      return json({ error: err.message }, 502);
    }
  }

  // ?report=budget lists the organisation's budgets; add &budget=<id> to read
  // one and see the twelve monthly overhead figures it produces.
  if (report === "budget") {
    try {
      const token = await getAccessToken();
      const pinned = (process.env.XERO_TENANTS ?? "")
        .split(",").map((x) => x.trim()).filter(Boolean);
      const all = await getConnections(token);
      const org = (pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all)[0];
      if (!org) return json({ error: "No Xero organisation connected." }, 409);

      const budgets = await listBudgets(token, org.tenantId);
      const wanted = url.searchParams.get("budget");
      if (!wanted) {
        return json({
          organisation: org.tenantName,
          budgets,
          next: budgets.length
            ? `Pick one and call again with &budget=<budgetID>`
            : `No budgets returned. Either none are set up, or the scope is missing.`,
        });
      }

      const fy = currentFiscalYear();
      const [budget, accounts] = await Promise.all([
        fetchBudget(token, org.tenantId, wanted, { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }),
        accountIndex(token, org.tenantId),
      ]);
      if (!budget) return json({ error: `Budget ${wanted} not found.` }, 404);

      const result = overheadsFromBudget(budget, accounts, fy);
      const a = await loadAssumptions(fy);
      const labels = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

      return json({
        organisation: org.tenantName,
        budget: { id: wanted, description: budget.Description, type: budget.Type },
        fiscalYearStartYear: fy,
        // Side by side with what the model currently assumes, which is the only
        // comparison that says whether adopting this is an improvement.
        comparison: labels.map((label, i) => ({
          month: label,
          budget: Math.round(result.months[i]),
          model: Math.round(a.monthlyOverheads?.[i] ?? 0),
          difference: Math.round(result.months[i] - (a.monthlyOverheads?.[i] ?? 0)),
        })),
        budgetTotal: Math.round(result.months.reduce((s, n) => s + n, 0)),
        modelTotal: Math.round((a.monthlyOverheads ?? []).reduce((s, n) => s + Number(n), 0)),
        monthsWithBudget: result.slotsCovered.length,
        includedAccounts: result.included,
        excludedAccounts: result.excluded,
        periodsSeen: result.periodsSeen,
      });
    } catch (err) {
      console.error(`[cash-xero-probe budget] ${err.message}`);
      return json({ error: err.message, hint: "A 403 mentioning scope means accounting.budgets.read was not granted — re-consent." }, 502);
    }
  }

  const started = Date.now();
  try {
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const all = await getConnections(token);
    const connections = pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all;
    const org = connections[0];
    if (!org) return json({ error: "No Xero organisation connected." }, 409);

    const { payments, truncated } = await fetchPayments(token, org.tenantId, month);
    const ids = payments.map((p) => p?.Invoice?.InvoiceID).filter(Boolean);
    const invoicesById = await fetchInvoicesByIds(token, org.tenantId, ids);

    const assumptions = await loadAssumptions(currentFiscalYear());
    const result = attributeReceipts(month, payments, invoicesById, assumptions.programs);

    const sample = payments[0];
    const sampleInvoice = sample?.Invoice?.InvoiceID
      ? invoicesById.get(sample.Invoice.InvoiceID)
      : null;

    return json({
      month,
      organisation: org.tenantName,
      paymentsFound: payments.length,
      paymentsTruncated: truncated,
      invoiceIdsOnPayments: ids.length,
      invoicesReturned: invoicesById.size,

      // The answer to "how much came in from students, by season".
      total: Math.round(result.total),
      bySeason: Object.fromEntries(
        Object.entries(result.bySeason).map(([k, v]) => [k, Math.round(v.base)]),
      ),
      byCurrency: result.byCurrency,
      unattributed: Math.round(result.unattributed),

      // The answer to "and why did anything land in Unattributed".
      diagnostics: result.diagnostics,
      programTrackingOptionsExpected: (assumptions.programs ?? [])
        .map((p) => p.xeroTrackingOption || p.name),

      // Field names only — see shapeOf above.
      shape: {
        payment: shapeOf(sample, ["Amount", "CurrencyRate", "Date", "PaymentType", "Status"]),
        paymentInvoice: shapeOf(sample?.Invoice, ["CurrencyCode", "Type"]),
        invoice: shapeOf(sampleInvoice, ["Type", "Status", "CurrencyCode", "LineAmountTypes"]),
        invoiceLine: shapeOf(sampleInvoice?.LineItems?.[0], ["AccountCode", "LineAmount"]),
        invoiceLineTracking: shapeOf(sampleInvoice?.LineItems?.[0]?.Tracking?.[0], ["Name", "Option"]),
      },

      durationMs: Date.now() - started,
    });
  } catch (err) {
    // The message matters more than the status here — a 403 means the scope is
    // missing and consent needs redoing, which looks nothing like a parse error.
    console.error(`[cash-xero-probe] ${err.message}`);
    return json({ error: err.message, durationMs: Date.now() - started }, 502);
  }
};
