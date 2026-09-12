/**
 * Shared Xero client for the Pacific Discovery dashboard.
 *
 * Auth model: standard OAuth2 authorization-code flow with `offline_access`.
 * One app connects to all four EDA Group tenants, so we need a single
 * refresh token, persisted and rotated. Xero rotates the refresh token on
 * EVERY refresh and the old one dies after a 30-minute grace window, so the
 * write-back is not optional — lose it and someone has to re-consent in Xero.
 *
 * Everything here assumes read-only scopes. Nothing in this file writes to Xero.
 */
import { getStore } from "@netlify/blobs";
const IDENTITY = "https://identity.xero.com";
const API = "https://api.xero.com";
/** Access tokens live 30 min; refresh a little early to avoid edge races. */
const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Refresh tokens live 60 days. Warn well before that. */
const REFRESH_TOKEN_TTL_DAYS = 60;
const REFRESH_WARN_DAYS = 14;
export const SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    // Granular scopes (custom connections got these 29 Apr 2026; broad scopes
    // like accounting.reports.read still work until Sept 2027 but are deprecated).
    "accounting.reports.banksummary.read",
    "accounting.reports.profitandloss.read",
    "accounting.reports.balancesheet.read",
    "accounting.reports.aged.read",
    // Receivable receipts: Payments carries the payment, Invoices carries the
    // line-item tracking that says which program (and so which season) it was
    // for.
    "accounting.payments.read",
    "accounting.invoices.read",
    // Bank transactions, for the cash rows.
    //
    // A Bank Summary gives four numbers per account — opening, received, spent,
    // closing — and nothing else. That is why Cash in reads 1,563,931 for June
    // against roughly 190,000 of student money: a summary cannot tell a customer
    // payment from an intercompany transfer, and cannot tell either from this
    // company moving its own USD into its own NZD account, which inflates both
    // Cash in and Cash out by the amount converted.
    //
    // The transaction list can. Xero types every bank transaction, and the two
    // transfer types (SPEND-TRANSFER / RECEIVE-TRANSFER) are exactly the
    // movements that should never count as cash in or out of the business. So
    // this one scope buys both the breakdown and the double-count fix.
    //
    // This scope was in the original consent and was removed when nothing read
    // it. It is a read scope like every other one here; nothing in this codebase
    // issues a non-GET request to the accounting API.
    "accounting.banktransactions.read",
    // Budget Manager, for forward overheads. Scope name unconfirmed against
    // Xero's docs (they render client-side); a 403 here means it is wrong and
    // the probe reports the message verbatim rather than swallowing it.
    "accounting.budgets.read",
    "accounting.settings.read",
].join(" ");
function tokenStore() {
    return getStore({ name: "cash-xero-auth", consistency: "strong" });
}
function basicAuth() {
    const id = requireEnv("XERO_CLIENT_ID");
    const secret = requireEnv("XERO_CLIENT_SECRET");
    return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}
export function requireEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing required environment variable: ${name}`);
    return v;
}
async function postToken(body) {
    const res = await fetch(`${IDENTITY}/connect/token`, {
        method: "POST",
        headers: {
            Authorization: basicAuth(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Xero token endpoint ${res.status}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
}
/**
 * Exchange the one-time authorization code for tokens. Run once, from the
 * callback function, to seed the store.
 */
export async function exchangeCode(code, redirectUri) {
    const json = await postToken(new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
    }));
    const record = {
        refresh_token: json.refresh_token,
        access_token: json.access_token,
        access_expires_at: Date.now() + json.expires_in * 1000,
        refreshed_at: Date.now(),
    };
    await tokenStore().setJSON("tokens", record);
    return record;
}
/**
 * Return a usable access token, refreshing if needed.
 *
 * Only the scheduled sync function should call this. If two invocations
 * refresh concurrently they both rotate the refresh token and one write
 * clobbers the other — survivable inside Xero's 30-minute grace window, but
 * not something to design around. Keep Xero calls on the single cron path.
 */
export async function getAccessToken() {
    const store = tokenStore();
    const record = (await store.get("tokens", { type: "json" }));
    if (!record?.refresh_token) {
        throw new Error("No Xero refresh token stored. Visit /.netlify/functions/cash-xero-auth once to authorise.");
    }
    const stillFresh = record.access_expires_at - REFRESH_SKEW_MS > Date.now();
    if (stillFresh)
        return record.access_token;
    const json = await postToken(new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: record.refresh_token,
    }));
    const next = {
        refresh_token: json.refresh_token,
        access_token: json.access_token,
        access_expires_at: Date.now() + json.expires_in * 1000,
        refreshed_at: Date.now(),
    };
    // Persist BEFORE returning. If this write fails we still have the 30-minute
    // grace window on the old refresh token, but we want to know about it.
    await store.setJSON("tokens", next);
    return next.access_token;
}
/** Days until the stored refresh token expires, for dashboard health display. */
export async function refreshTokenHealth() {
    const record = (await tokenStore().get("tokens", { type: "json" }));
    if (!record)
        return null;
    const ageDays = (Date.now() - record.refreshed_at) / 86_400_000;
    const daysRemaining = Math.max(0, REFRESH_TOKEN_TTL_DAYS - ageDays);
    return {
        daysRemaining: Math.round(daysRemaining),
        needsAttention: daysRemaining < REFRESH_WARN_DAYS,
    };
}
export async function getConnections(accessToken) {
    const res = await fetch(`${API}/connections`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) {
        throw new Error(`Xero /connections ${res.status}: ${await res.text()}`);
    }
    const all = (await res.json());
    return all.filter((c) => c.tenantType === "ORGANISATION");
}
/**
 * Call a Xero Accounting API endpoint for one tenant.
 * Retries once on 429, honouring the Retry-After header.
 */
export async function xeroGet(accessToken, tenantId, path, params = {}) {
    const url = new URL(`${API}/api.xro/2.0/${path}`);
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Xero-tenant-id": tenantId,
                Accept: "application/json",
            },
        });
        if (res.status === 429 && attempt === 0) {
            const wait = Number(res.headers.get("Retry-After") ?? "5");
            await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
            continue;
        }
        if (!res.ok) {
            throw new Error(`Xero ${path} for ${tenantId} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        return res.json();
    }
    throw new Error(`Xero ${path} for ${tenantId}: rate limited after retry`);
}
/* ------------------------------------------------------------------ *
 * Report parsing
 *
 * Xero reports come back as nested Rows/Cells rather than anything
 * tabular. These helpers flatten the two shapes we actually need.
 * ------------------------------------------------------------------ */
function cellValue(cell) {
    const raw = cell?.Value;
    if (raw === undefined || raw === null || raw === "")
        return 0;
    const n = Number(String(raw).replace(/[(),$\s]/g, ""));
    if (Number.isNaN(n))
        return 0;
    // Xero renders negatives in parentheses in some report cells.
    return /^\(.*\)$/.test(String(raw)) ? -n : n;
}
/**
 * BankSummary → closing balance per bank account, plus the total.
 * Columns are: Account | Opening | Cash Received | Cash Spent | Closing.
 */
export function parseBankSummary(report) {
    const rows = report?.Reports?.[0]?.Rows ?? [];
    const accounts = [];
    for (const section of rows) {
        if (section.RowType !== "Section")
            continue;
        for (const row of section.Rows ?? []) {
            const cells = row.Cells ?? [];
            if (cells.length < 5)
                continue;
            const name = cells[0]?.Value ?? "";
            if (!name)
                continue;
            accounts.push({
                name,
                opening: cellValue(cells[1]),
                received: cellValue(cells[2]),
                spent: cellValue(cells[3]),
                closing: cellValue(cells[4]),
                isTotal: row.RowType === "SummaryRow",
            });
        }
    }
    const detail = accounts.filter((a) => !a.isTotal);
    const summary = accounts.find((a) => a.isTotal);
    const totalClosing = summary
        ? summary.closing
        : detail.reduce((sum, a) => sum + a.closing, 0);
    return {
        accounts: detail.map(({ isTotal, ...rest }) => rest),
        totalClosing,
    };
}
/**
 * Find a named line in any Xero report and return its first numeric column.
 *
 * Report row nesting varies by report and by org chart-of-accounts depth, so
 * walk it recursively rather than assuming a shape.
 *
 * Note: do NOT use AgedReceivablesByContact/AgedPayablesByContact for a
 * whole-org total — those reports require a ContactID and return one contact
 * at a time. The BalanceSheet carries the org-wide figure in one call.
 */
export function findReportLine(report, pattern) {
    const walk = (rows) => {
        for (const row of rows ?? []) {
            const cells = row.Cells ?? [];
            const label = cells[0]?.Value;
            if (typeof label === "string" && pattern.test(label) && cells.length > 1) {
                return cellValue(cells[1]);
            }
            if (row.Rows?.length) {
                const found = walk(row.Rows);
                if (found !== null)
                    return found;
            }
        }
        return null;
    };
    return walk(report?.Reports?.[0]?.Rows ?? []);
}
/** Receivables and payables as at the balance sheet date. */
export function parseBalanceSheet(report) {
    return {
        receivables: findReportLine(report, /^accounts receivable/i) ?? 0,
        // Payables sit as a positive figure under liabilities in Xero's layout.
        payables: Math.abs(findReportLine(report, /^accounts payable/i) ?? 0),
    };
}
export function monthBounds(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0));
    return { from: iso(first), to: iso(last) };
}
export function iso(d) {
    return d.toISOString().slice(0, 10);
}
export async function getTrackingCategories(accessToken, tenantId) {
    const json = await xeroGet(accessToken, tenantId, "TrackingCategories");
    return (json?.TrackingCategories ?? []).map((c) => ({
        trackingCategoryID: c.TrackingCategoryID,
        name: c.Name,
        options: (c.Options ?? [])
            .filter((o) => o.Status === "ACTIVE")
            .map((o) => ({ trackingOptionID: o.TrackingOptionID, name: o.Name })),
    }));
}
/** Pick the category whose name looks like the program dimension. */
export function pickProgramCategory(categories, preferredName) {
    if (preferredName) {
        const exact = categories.find((c) => c.name.toLowerCase() === preferredName.toLowerCase());
        if (exact)
            return exact;
    }
    return (categories.find((c) => /program|programme|trip|course/i.test(c.name)) ??
        categories[0] ??
        null);
}
/**
 * Profit & loss for a period, broken out by tracking option.
 *
 * Xero returns a header row naming each column and then rows whose cells line
 * up with it. Column positions are not stable across orgs, so map names to
 * indices from the header rather than assuming an order.
 */
export function parseTrackedProfitAndLoss(report, categoryName) {
    const rows = report?.Reports?.[0]?.Rows ?? [];
    const header = rows.find((r) => r.RowType === "Header");
    const columns = (header?.Cells ?? []).map((c) => String(c?.Value ?? ""));
    const byOption = {};
    for (let i = 1; i < columns.length; i++) {
        const name = columns[i].trim();
        if (!name || /^total$/i.test(name))
            continue;
        byOption[name] = { income: 0, expenses: 0, net: 0 };
    }
    const readRow = (row, into) => {
        const cells = row.Cells ?? [];
        for (let i = 1; i < columns.length; i++) {
            const name = columns[i].trim();
            if (!byOption[name])
                continue;
            byOption[name][into] += cellValue(cells[i]);
        }
    };
    const walk = (list, section) => {
        for (const row of list ?? []) {
            const title = row.Title ?? row.Cells?.[0]?.Value ?? "";
            const nextSection = /income|revenue/i.test(String(title))
                ? "income"
                : /expense|cost of sales|operating/i.test(String(title))
                    ? "expenses"
                    : section;
            if (row.RowType === "SummaryRow" && /^total/i.test(String(row.Cells?.[0]?.Value ?? ""))) {
                if (nextSection === "income")
                    readRow(row, "income");
                else if (nextSection === "expenses")
                    readRow(row, "expenses");
            }
            if (row.Rows?.length)
                walk(row.Rows, nextSection);
        }
    };
    walk(rows, "");
    for (const k of Object.keys(byOption)) {
        byOption[k].net = byOption[k].income - byOption[k].expenses;
    }
    return { byOption, categoryName };
}
export async function getTrackedActuals(accessToken, tenantId, from, to, category) {
    const report = await xeroGet(accessToken, tenantId, "Reports/ProfitAndLoss", {
        fromDate: from,
        toDate: to,
        trackingCategoryID: category.trackingCategoryID,
    });
    return parseTrackedProfitAndLoss(report, category.name);
}
/**
 * Deferred revenue: cash taken for trips that haven't been recognised yet.
 * This is the account that reconciles the two timelines, so it's worth
 * surfacing next to the forecast's own computed deferred balance.
 */
export function parseDeferredRevenue(balanceSheet, accountNamePattern) {
    return Math.abs(findReportLine(balanceSheet, accountNamePattern) ?? 0);
}
/** Fiscal-year bounds (1 Apr – 31 Mar) for a given start year. */
export function fiscalYearBounds(fyStartYear) {
    return { from: `${fyStartYear}-04-01`, to: `${fyStartYear + 1}-03-31` };
}


/* ------------------------------------------------------------------ *
 * Monthly history
 *
 * The dashboard replaces closed months with what actually happened, so it needs
 * a Bank Summary per month rather than one for the current month. Closed months
 * do not change, so they are cached and re-fetched only while still recent.
 * ------------------------------------------------------------------ */

/** ["2026-04", "2026-05", ...] from the fiscal year start up to `upTo` (inclusive). */
export function fiscalMonthKeys(fyStartYear, upTo = new Date()) {
    const keys = [];
    const cutoff = `${upTo.getUTCFullYear()}-${String(upTo.getUTCMonth() + 1).padStart(2, "0")}`;
    for (let i = 0; i < 12; i++) {
        const abs = 3 + i; // April is calendar month index 3
        const y = fyStartYear + Math.floor(abs / 12);
        const m = (abs % 12) + 1;
        const key = `${y}-${String(m).padStart(2, "0")}`;
        if (key > cutoff) break;
        keys.push(key);
    }
    return keys;
}

/** First and last day of a "YYYY-MM" key. */
export function monthRange(key) {
    const [y, m] = key.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, "0")}` };
}

/**
 * Bank Summary for one month, reduced to per-currency received / spent /
 * closing. Accounts are grouped by the currency of the account, which is what
 * lets the dashboard show a real NZD balance and a real USD balance rather than
 * one blended figure.
 */
export async function fetchMonthActuals(accessToken, tenantId, key, accountCurrency, now = new Date()) {
    const { from, to } = monthRange(key);
    // A month that has not finished yet still returns a Bank Summary — Xero is
    // happy to report the first eight days of September. Storing it is useful
    // (the dashboard can show progress), but presenting it as a closed month
    // would understate every figure and re-base the rest of the year onto a
    // balance that is a week old. Flag it so nothing downstream can close on it.
    const partial = new Date(`${to}T23:59:59Z`).getTime() > now.getTime();
    const report = await xeroGet(accessToken, tenantId, "Reports/BankSummary", {
        fromDate: from,
        toDate: to,
    });
    const parsed = parseBankSummary(report);

    const byCurrency = {};
    for (const acc of parsed.accounts) {
        const cur = accountCurrency(acc.name);
        const c = (byCurrency[cur] ||= { received: 0, spent: 0, closing: 0, opening: 0 });
        c.opening += acc.opening;
        c.received += acc.received;
        // Xero reports "Cash Spent" as a positive magnitude in this column.
        c.spent += Math.abs(acc.spent);
        c.closing += acc.closing;
    }

    return {
        month: key,
        byCurrency,
        accounts: parsed.accounts,
        partial,
        source: "Xero Bank Summary",
        fetchedAt: new Date().toISOString(),
    };
}

/**
 * Bank accounts and their currencies, so a month's figures can be split by the
 * currency actually held rather than assumed.
 */
export async function getBankAccountCurrencies(accessToken, tenantId, baseCurrency = "NZD") {
    const map = new Map();
    try {
        const json = await xeroGet(accessToken, tenantId, "Accounts", {
            where: 'Type=="BANK"',
        });
        for (const a of json?.Accounts ?? []) {
            if (a.Name) map.set(a.Name.trim().toLowerCase(), a.CurrencyCode || baseCurrency);
        }
    } catch {
        // Without the account list every balance falls back to the base
        // currency. Better a stated assumption than a guessed split.
    }
    return (name) => map.get(String(name).trim().toLowerCase()) || baseCurrency;
}
