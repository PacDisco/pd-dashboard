/**
 * Scheduled sync — the only thing that talks to Xero.
 *
 * Runs hourly, pulls a cash position for every connected organisation, and
 * writes one consolidated JSON blob. The dashboard reads that blob, so no
 * page view ever waits on Xero and no page view burns API quota.
 *
 * Call budget per org per run: 5 — BankSummary, BalanceSheet, Organisation,
 * TrackingCategories, and a tracked ProfitAndLoss. The P&L returns every
 * program as columns in one response, so this does NOT grow as programs are
 * added. Hourly → 120/day/org against a Starter limit of 1000/day/org.
 */
import { getStore } from "@netlify/blobs";
import { getAccessToken, getConnections, xeroGet, parseBankSummary, parseBalanceSheet, refreshTokenHealth, monthBounds, iso, getTrackingCategories, pickProgramCategory, getTrackedActuals, fiscalYearBounds, } from "./_shared/cash-xero.mjs";
async function orgCurrency(token, tenantId) {
    try {
        const org = await xeroGet(token, tenantId, "Organisation");
        return org?.Organisations?.[0]?.BaseCurrency ?? "NZD";
    }
    catch {
        return "NZD";
    }
}
async function pullOrg(token, tenantId, name, from, to) {
    const base = {
        tenantId,
        name,
        currency: "NZD",
        bankAccounts: [],
        closingBalance: 0,
        cashReceivedMTD: 0,
        cashSpentMTD: 0,
        receivables: 0,
        payables: 0,
    };
    try {
        const [bankSummary, balanceSheet, currency] = await Promise.all([
            xeroGet(token, tenantId, "Reports/BankSummary", { fromDate: from, toDate: to }),
            xeroGet(token, tenantId, "Reports/BalanceSheet", { date: to }).catch(() => null),
            orgCurrency(token, tenantId),
        ]);
        const parsed = parseBankSummary(bankSummary);
        const bs = balanceSheet ? parseBalanceSheet(balanceSheet) : { receivables: 0, payables: 0 };
        // Per-program actuals, for the fiscal year to date. One extra call for the
        // category list, one for the P&L — the P&L returns every program at once
        // as columns, so this doesn't scale with the number of programs.
        let byProgram;
        try {
            const categories = await getTrackingCategories(token, tenantId);
            const category = pickProgramCategory(categories, process.env.XERO_PROGRAM_CATEGORY);
            if (category) {
                const fy = fiscalYearBounds(currentFiscalYear());
                byProgram = await getTrackedActuals(token, tenantId, fy.from, to, category);
            }
        }
        catch {
            // Tracking is a bonus, not a dependency. A org without it still syncs.
        }
        return {
            ...base,
            byProgram,
            currency,
            bankAccounts: parsed.accounts,
            closingBalance: parsed.totalClosing,
            cashReceivedMTD: parsed.accounts.reduce((s, a) => s + a.received, 0),
            cashSpentMTD: parsed.accounts.reduce((s, a) => s + a.spent, 0),
            receivables: bs.receivables,
            payables: bs.payables,
        };
    }
    catch (err) {
        // One bad org shouldn't take down the whole sync.
        return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
}
export default async (_req, _context) => {
    const started = Date.now();
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    let connections = await getConnections(token);
    if (pinned.length) {
        connections = pinned
            .map((id) => connections.find((c) => c.tenantId === id))
            .filter((c) => Boolean(c));
    }
    const { from, to } = monthBounds();
    // Sequential, not parallel across orgs — Xero rate limits per app as well as
    // per org, and four orgs is not worth the concurrency risk.
    const orgs = [];
    for (const c of connections) {
        orgs.push(await pullOrg(token, c.tenantId, c.tenantName, from, to));
    }
    const health = await refreshTokenHealth();
    // Group total is only meaningful where currencies match. Anything else is
    // reported per currency — do NOT silently add NZD and USD together.
    const byCurrency = {};
    for (const o of orgs) {
        if (o.error)
            continue;
        byCurrency[o.currency] = (byCurrency[o.currency] ?? 0) + o.closingBalance;
    }
    const payload = {
        generatedAt: new Date().toISOString(),
        periodFrom: from,
        periodTo: to,
        asAt: iso(new Date()),
        orgs,
        groupClosingByCurrency: byCurrency,
        tokenHealth: health,
        errors: orgs.filter((o) => o.error).map((o) => ({ name: o.name, error: o.error })),
        durationMs: Date.now() - started,
    };
    await getStore({ name: "cash-xero" }).setJSON("latest", payload);
    // Keep a dated snapshot so you can chart actual vs forecast over time
    // instead of only ever seeing "now".
    await getStore({ name: "cash-xero-history" }).setJSON(payload.asAt, payload);
    return new Response(JSON.stringify({ ok: true, orgs: orgs.length, errors: payload.errors }), {
        headers: { "Content-Type": "application/json" },
    });
};
export const config = {
    schedule: "@hourly",
};
/** Fiscal year starting April. Before April we're still in last year's. */
function currentFiscalYear() {
    const now = new Date();
    return now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
