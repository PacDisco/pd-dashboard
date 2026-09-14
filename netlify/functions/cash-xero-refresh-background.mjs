// netlify/functions/cash-xero-refresh-background.mjs
//
// The refresh, run somewhere it actually fits.
//
// WHY A BACKGROUND FUNCTION
// -------------------------
// A synchronous Netlify function gets ten seconds. A full refresh is twelve
// Bank Summaries, twelve months of transactions and eleven P&L calls — and a
// single month of transactions is not one call, it is six or more: Xero pages
// at 100 and June alone has 328 bank transactions, 77 payments and 31
// transfers.
//
// I tried to fit it in ten seconds twice. First with a clock, then with a cap
// of four "pulls" — but a pull was a whole month of transactions, so four pulls
// could be twenty-four Xero calls and the function was killed again. Each
// attempt made the budget smaller against a limit that was never going to be
// big enough.
//
// A function whose name ends in `-background` gets fifteen minutes and returns
// 202 immediately. The work goes here, progress goes to a blob, and the
// dashboard polls it. Nothing is racing a stopwatch any more.
//
// READ-ONLY AGAINST XERO. Every Xero request is a GET; writes go to this
// application's own blob store.

import { getStore } from "@netlify/blobs";
import { getAccessToken, getConnections } from "./_shared/cash-xero.mjs";
import { currentFiscalYear } from "./_shared/cash-store.mjs";
import { refreshAll, refreshSummary, budgetOf, STATUS_KEY, statusStore } from "./_shared/cash-refresh.mjs";

export default async (req) => {
  // Netlify has already authorised this: a background function is only reachable
  // from the site itself, and the endpoint that triggers it checks the role.
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const by = url.searchParams.get("by") || "unknown";
  const started = Date.now();
  const store = statusStore();

  const write = (patch) => store.setJSON(STATUS_KEY, {
    startedAt: new Date(started).toISOString(),
    by, force, ...patch,
  });

  try {
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const all = await getConnections(token);
    const org = (pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all)[0];
    if (!org) {
      await write({ running: false, done: false, error: "No Xero organisation connected." });
      return new Response("", { status: 202 });
    }

    await write({ running: true, done: false, organisation: org.tenantName });

    const fy = currentFiscalYear();
    // Twelve minutes of a fifteen-minute allowance, and a unit cap high enough
    // to cover a whole year. The budget stays in place as a backstop rather
    // than a constraint — if something is pathologically slow it should stop
    // and report, not be killed with no record of how far it got.
    const result = await refreshAll(token, org.tenantId, fy, {
      // Two fiscal years of transactions plus this year's summaries, P&L and
      // budget: a shade under a hundred pulls on a first full run.
      force, budget: budgetOf(12 * 60_000, 120),
    });

    const durationMs = Date.now() - started;
    console.log(`[cash-xero-refresh-background] by=${by} force=${force} ${refreshSummary(result)} durationMs=${durationMs}`);

    await write({
      running: false,
      done: result.done,
      organisation: org.tenantName,
      finishedAt: new Date().toISOString(),
      durationMs,
      summary: refreshSummary(result),
      months: result.months,
      transactions: result.transactions,
      opex: result.opex,
      budget: result.budget,
      remaining: result.remaining,
      // An error inside one pass does not stop the others, so collect them
      // rather than letting a single failure look like a clean run.
      errors: Object.entries(result)
        .filter(([, v]) => v && typeof v === "object" && v.error)
        .map(([name, v]) => ({ pass: name, error: v.error })),
    });
  } catch (err) {
    console.error(`[cash-xero-refresh-background] ${err.message}`);
    await write({ running: false, done: false, error: err.message,
      finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
  }

  return new Response("", { status: 202 });
};
