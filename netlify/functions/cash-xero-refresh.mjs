// netlify/functions/cash-xero-refresh.mjs
//
// Refresh the stored Xero data now, instead of waiting for the hourly sync.
//
//   POST /api/cash-xero-refresh          respect the cache, refetch what is stale
//   POST /api/cash-xero-refresh?force=1   refetch every month regardless
//
// WHY
// ---
// Closed months are cached forever and the dashboard reads the cache, so after
// a parser fix the dashboard keeps showing the old figures until the scheduled
// sync happens to run. Twice now the honest answer to "it's still wrong" has
// been "wait an hour", which is unverifiable and indistinguishable from the fix
// not working. This makes it a button.
//
// POST, not GET: it costs Xero API calls and rewrites stored data, so it should
// not be something a browser can be talked into doing by following a link.
// Write role, same as the probe. Read-only against Xero — every request it
// makes is a GET; the writes are to this application's own blob store.

import { getStore } from "@netlify/blobs";
import { requireCashRole, json } from "./_shared/cash-access.mjs";
import { getAccessToken, getConnections } from "./_shared/cash-xero.mjs";
import { currentFiscalYear } from "./_shared/cash-store.mjs";
import { refreshAll, refreshSummary, budgetOf } from "./_shared/cash-refresh.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "write", "cash-xero-refresh");
  if (user instanceof Response) return user;

  if (req.method !== "POST") {
    return json({ error: "POST to refresh. This calls Xero and rewrites stored months." }, 405);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const started = Date.now();

  try {
    const token = await getAccessToken();
    const pinned = (process.env.XERO_TENANTS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const all = await getConnections(token);
    const org = (pinned.length ? all.filter((c) => pinned.includes(c.tenantId)) : all)[0];
    if (!org) return json({ error: "No Xero organisation connected." }, 409);

    const fy = currentFiscalYear();
    /* Five seconds AND at most four pulls, whichever runs out first.
     *
     * The count is the part that makes this reliable. A clock can only stop
     * work that has not started, and one month of transactions is three paged
     * Xero endpoints — enough on its own to blow a ten-second function. Four
     * pulls is comfortably under the limit even when Xero is slow.
     *
     * The cost of being wrong here is not a slow response, it is no response:
     * a killed function returns Netlify's HTML error page, the client cannot
     * parse it, and the only thing anyone sees is "response was not JSON". */
    const result = await refreshAll(token, org.tenantId, fy, {
      force, budget: budgetOf(5000, 4),
    });
    const durationMs = Date.now() - started;

    console.log(`[cash-xero-refresh] by=${user.email} force=${force} ${refreshSummary(result)} durationMs=${durationMs}`);

    // A refresh that fetched nothing is the confusing case — it looks the same
    // as one that failed. Say which it was.
    const touched = result.months.fetched + result.transactions.fetched + result.opex.fetched;
    return json({
      ok: true,
      organisation: org.tenantName,
      fiscalYearStartYear: fy,
      force,
      ...result,
      summary: refreshSummary(result),
      note: !result.done
        ? `${touched} pulled this pass, ${result.remaining} still to go — call again to continue.`
        : touched === 0
          ? "Nothing needed refetching — every stored month already came from the current parsers. Use force to refetch anyway."
          : `${touched} pull${touched === 1 ? "" : "s"} completed. Reload the dashboard to see them.`,
      durationMs,
    });
  } catch (err) {
    console.error(`[cash-xero-refresh] ${err.message}`);
    return json({ error: err.message }, 502);
  }
};
