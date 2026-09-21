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
  getAccessToken, getConnections, xeroGet,
  parseBankSummary, bankSummaryColumns, monthRange,
  isMonthRecordCurrent, BANKSUMMARY_PARSER_VERSION,
} from "./_shared/cash-xero.mjs";
import {
  fetchBankTransactions,
  fetchAllPayments,
  fetchBankTransfers,
  bankAccountIndex,
  transferLegCoverage,
  summariseSources,
  reconcile,
} from "./_shared/cash-bank-tx.mjs";
import { loadAssumptions, currentFiscalYear, resolveOpeningBalances } from "./_shared/cash-store.mjs";
import { fiscalMonthKeys } from "./_shared/cash-xero.mjs";
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

  /* A LIVE pull as well as the stored one.
   *
   * The stored blob is what the forecast reads, and it only changes when the
   * hourly sync rewrites it — so after a parser fix the warnings persist until
   * that runs, and there is no way to tell "fix not deployed" from "fix
   * deployed, cache not yet refreshed" by looking at the dashboard.
   *
   * More importantly: the FX-gain diagnosis was made from symptoms — NZD
   * closing exactly zero, USD closing revaluation-sized — and NOT from seeing
   * Xero's header row. Printing the actual column titles is what turns that
   * from a good inference into a fact. */
  let live = null;
  try {
    const token = await getAccessToken();
    const { from, to } = monthRange(month);
    const report = await xeroGet(token, tenantId, "Reports/BankSummary", { fromDate: from, toDate: to });
    const cols = bankSummaryColumns(report);
    const parsed = parseBankSummary(report);
    live = {
      // THE ANSWER. If "FX Gain" (or similar) sits between Cash Spent and
      // Closing Balance, the diagnosis is confirmed and the fix is right.
      columnTitles: cols.titles,
      columnsUsed: {
        opening: cols.opening, received: cols.received, spent: cols.spent,
        fxGain: cols.fxGain, closing: cols.closing,
      },
      resolvedFromHeader: cols.resolvedFromHeader,
      accountCount: parsed.accounts.length,
      // A few accounts with every column, so the identity can be checked by eye:
      // opening + received - spent + fxGain should equal closing.
      sampleAccounts: parsed.accounts.slice(0, 6).map((a) => ({
        name: a.name,
        opening: Math.round(a.opening),
        received: Math.round(a.received),
        spent: Math.round(a.spent),
        fxGain: Math.round(a.fxGain ?? 0),
        closing: Math.round(a.closing),
        identityHolds:
          Math.abs((a.opening + a.received - Math.abs(a.spent) + (a.fxGain ?? 0)) - a.closing) < 1,
      })),
    };
  } catch (err) {
    live = { error: err.message };
  }

  return {
    month,
    live,
    // Whether the blob the forecast reads was written by the current parser.
    // "false" with a deployed fix means the sync has not run yet — the warnings
    // will clear on its next pass, without any further change.
    storedParserVersion: record?.parserVersion ?? null,
    storedIsCurrent: isMonthRecordCurrent(record),
    expectedParserVersion: BANKSUMMARY_PARSER_VERSION,
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
  if (!["budget", "costs"].includes(report) && !/^\d{4}-\d{2}$/.test(month ?? "")) {
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

      const accounts = await bankAccountIndex(token, org.tenantId, "NZD");
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
        accounts,
      });

      // Compared against the SAME stored month the forecast reads, not a fresh
      // pull — so this checks what the dashboard is actually showing.
      const { getStore } = await import("@netlify/blobs");
      const stored = await getStore({ name: "cash-xero-months" })
        .get(`${org.tenantId}/${month}`, { type: "json" });
      const reconciliation = reconcile(summarised, {
        byCurrency: stored?.byCurrency ?? {},
        accounts: stored?.accounts ?? null,
      });

      // Exact, not inferred: a BankTransfer names the two bank transactions it
      // created, so whether both legs came back is a set membership test.
      const legs = transferLegCoverage(transferResult.transfers, bankTransactions);

      const sampleTx = bankTransactions[0];
      const samplePayment = payments[0];

      return json({
        month,
        organisation: org.tenantName,
        bankAccountsKnown: accounts.size,
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

        // THE ANSWER. currencyRows is the verdict; worstAccounts says WHERE,
        // which with nineteen bank accounts is the only actionable form.
        reconciliation: {
          ties: reconciliation.ties,
          currencyRows: reconciliation.currencyRows,
          worstAccounts: reconciliation.worstAccounts,
        },
        transferLegs: legs,
        storedMonthPresent: Boolean(stored),
        storedAccountRows: stored?.accounts?.length ?? 0,

        businessMovement: summarised.byCurrency,
        ownTransfers: summarised.transfersByCurrency,

        typesSeen: [...new Set(bankTransactions.map((t) => t?.Type).filter(Boolean))],
        paymentTypesSeen: [...new Set(payments.map((p) => p?.PaymentType).filter(Boolean))],
        unknownTypes: summarised.unknownTypes,
        bankAccountsSeen: summarised.accountsSeen,

        sampleBankTransactionShape: shapeOf(sampleTx, ["Type", "CurrencyCode", "CurrencyRate"]),
        bankTransactionHasLineItems: Array.isArray(sampleTx?.LineItems),
        sampleLineItemShape: shapeOf(sampleTx?.LineItems?.[0], ["AccountCode"]),
        samplePaymentShape: shapeOf(samplePayment, ["PaymentType", "CurrencyRate"]),
        sampleTransferShape: shapeOf(transferResult.transfers?.[0], ["Amount", "CurrencyRate"]),
      });
    } catch (err) {
      console.error(`[cash-xero-probe banktx] ${err.message}`);
      return json({
        error: err.message,
        hint: "A 403 mentioning scope means accounting.banktransactions.read was not granted — re-consent.",
      }, 502);
    }
  }

  // ?report=costs answers the one question the cost-phasing rebuild rests on:
  // can outgoing money be tied to a program at all, and by which route?
  //
  // Reads the STORED transaction months, so it reflects exactly what a derived
  // curve would be built from. Program names and account codes only — no
  // supplier names, references or amounts per contact.
  if (report === "costs") {
    const { getStore } = await import("@netlify/blobs");
    const latest = await getStore({ name: "cash-xero" }).get("latest", { type: "json" });
    const tenantId = latest?.orgs?.[0]?.tenantId;
    if (!tenantId) return json({ error: "No synced organisation yet." }, 409);

    const txStore = getStore({ name: "cash-xero-tx" });
    const fy = currentFiscalYear();
    const months = [];
    // Both fiscal years, because a curve needs complete program cycles and this
    // year alone is all pre-departure for Fall.
    for (const y of [fy - 1, fy]) {
      for (const key of fiscalMonthKeys(y, new Date(`${y + 1}-03-31T00:00:00Z`))) {
        const rec = await txStore.get(`${tenantId}/${key}`, { type: "json" });
        if (rec?.costs) months.push({ month: key, ...rec.costs, billsFetched: rec.billsFetched, billsReferenced: rec.billsReferenced });
      }
    }

    if (!months.length) {
      return json({ error: "No transaction months stored yet — run a forced refresh first." }, 409);
    }

    // Weighted across every month, because one quiet month proves nothing.
    const total = months.reduce((s, m) => s + (m.totalOut || 0), 0);
    const weighted = (route) => (total > 0
      ? Math.round(months.reduce((s, m) => s + (m.totalOut || 0) * ((m.coverage?.[route] ?? 0) / 100), 0) / total * 1000) / 10
      : 0);

    // Every tracking category seen anywhere, so nothing is assumed about what
    // they are called. Pacific Discovery uses "Program" and "Season"; the code
    // reads whatever is actually there.
    const categories = [...new Set(months.flatMap((m) => m.categoriesSeen ?? []))];

    const mergeCategory = (cat) => {
      const out = {};
      for (const m of months) {
        for (const [k, v] of Object.entries(m.byCategory?.[cat] ?? {})) out[k] = (out[k] ?? 0) + v;
      }
      return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 60));
    };
    const merge = (field) => {
      const out = {};
      for (const m of months) for (const [k, v] of Object.entries(m[field] ?? {})) out[k] = (out[k] ?? 0) + v;
      return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 40));
    };

    const a = await loadAssumptions(fy);
    const programNames = new Set((a.programs ?? []).flatMap(
      (p) => [p.xeroTrackingOption, p.name].filter(Boolean).map((n) => String(n).trim().toLowerCase())));
    const modelSeasons = new Set((a.programs ?? []).map((p) => p.season).filter(Boolean));

    const byCategory = Object.fromEntries(categories.map((c) => [c, mergeCategory(c)]));

    return json({
      monthsStored: months.length,
      fiscalYears: [fy - 1, fy],
      totalOutAcrossMonths: Math.round(total),
      categoriesSeen: categories,
      // THE ANSWER. Share of outgoing money each route can attribute, weighted
      // across both years. One line per tracking category, because Program and
      // Season are tagged independently and one can be well kept and the other
      // not.
      coverageWeighted: {
        ...Object.fromEntries(categories.map((c) => [c, weighted(c)])),
        accountCode: weighted("accountCode"),
      },
      // The option names themselves, so a mapping can be proposed rather than
      // guessed — and so a category full of names nothing recognises is visible
      // rather than hiding behind a good coverage number.
      byCategory,
      byBankAccount: merge("byBankAccount"),
      byAccountCode: merge("byAccountCode"),
      // Do the names line up with the model? High coverage against labels the
      // forecast does not recognise is worth less than lower coverage against
      // ones it does.
      matchAgainstModel: Object.fromEntries(categories.map((c) => {
        const names = Object.keys(byCategory[c] ?? {});
        const known = /season/i.test(c) ? modelSeasons : programNames;
        const norm = (n) => String(n).trim().toLowerCase();
        const knownNorm = new Set([...known].map(norm));
        return [c, {
          matched: names.filter((n) => knownNorm.has(norm(n))),
          unmatched: names.filter((n) => !knownNorm.has(norm(n))),
        }];
      })),
      programsInModel: (a.programs ?? []).map((p) => ({ name: p.name, season: p.season, departs: p.startDate })),
      seasonsInModel: [...modelSeasons],
      unattributable: {
        spendWithoutLineDetail: months.reduce((s, m) => s + (m.spendWithoutLineDetail || 0), 0),
        unconverted: months.reduce((s, m) => s + (m.unconverted || 0), 0),
        billsFetched: months.reduce((s, m) => s + (m.billsFetched || 0), 0),
        billsReferenced: months.reduce((s, m) => s + (m.billsReferenced || 0), 0),
      },
      perMonth: months.map((m) => ({
        month: m.month, totalOut: m.totalOut, coverage: m.coverage,
        spendWithoutLineDetail: m.spendWithoutLineDetail,
      })),
    });
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
        // Account and annual amount only. Each entry now also carries a
        // twelve-month split, which the P&L needs and a probe response does
        // not — forty accounts of monthly detail would bury the two figures
        // anyone actually opens this endpoint to read.
        includedAccounts: result.included.map(({ account, amount }) => ({ account, amount })),
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
