// netlify/functions/cash-xero-refresh.mjs
//
// Start a refresh, and report how one is going.
//
//   POST /api/cash-xero-refresh            start (respecting the cache)
//   POST /api/cash-xero-refresh?force=1    start, refetching everything
//   GET  /api/cash-xero-refresh            how the running or last refresh went
//
// The work itself happens in cash-xero-refresh-background.mjs, which gets
// fifteen minutes instead of ten seconds. This endpoint only starts it and
// reads the status blob it writes — so it always returns quickly, which is the
// whole point: three attempts at squeezing a sixty-call refresh into a
// ten-second function produced three HTTP 504s and no data.
//
// POST to start, because it spends Xero calls and rewrites stored data — not
// something a link or a prefetch should be able to trigger. Write role, same as
// the probe. Read-only against Xero.

import { requireCashRole, canEdit, json } from "./_shared/cash-access.mjs";
import { STATUS_KEY, statusStore } from "./_shared/cash-refresh.mjs";

/** A run older than this is over, whatever its status blob still claims. */
const STALE_AFTER_MS = 16 * 60_000;

function withStaleness(status) {
  if (!status) return { running: false, never: true };
  const age = Date.now() - new Date(status.startedAt ?? 0).getTime();
  // A worker killed mid-run leaves `running: true` forever. Past the maximum a
  // background function can live, that claim is simply false — and a refresh
  // that can never be started again because of a stuck flag is worse than one
  // that occasionally runs twice.
  if (status.running && age > STALE_AFTER_MS) {
    return { ...status, running: false, stalled: true,
      error: status.error ?? "The refresh stopped without finishing. Start it again." };
  }
  return status;
}

export default async (req) => {
  const user = await requireCashRole(req, "read", "cash-xero-refresh");
  if (user instanceof Response) return user;

  const store = statusStore();

  if (req.method === "GET") {
    const status = await store.get(STATUS_KEY, { type: "json" });
    return json({ status: withStaleness(status) });
  }

  if (req.method !== "POST") {
    return json({ error: "POST to start a refresh, GET to check on one." }, 405);
  }
  if (!canEdit(user)) {
    return json({ error: "Starting a refresh needs write access." }, 403);
  }

  const current = withStaleness(await store.get(STATUS_KEY, { type: "json" }));
  if (current?.running) {
    return json({
      started: false,
      status: current,
      note: "A refresh is already running. Watch this endpoint rather than starting another.",
    });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  // Claim the run BEFORE invoking, so a second click during the round trip sees
  // it and does not start a duplicate.
  await store.setJSON(STATUS_KEY, {
    running: true, done: false, startedAt: new Date().toISOString(),
    by: user.email, force, summary: "starting…",
  });

  // Netlify returns 202 immediately for a *-background function and keeps
  // running it for up to fifteen minutes.
  const target = new URL("/.netlify/functions/cash-xero-refresh-background", url.origin);
  target.searchParams.set("force", force ? "1" : "0");
  target.searchParams.set("by", user.email);

  try {
    const res = await fetch(target, { method: "POST" });
    if (res.status !== 202) {
      // Background functions are not available on every plan. Say so plainly
      // rather than leaving a run flagged as started that will never happen.
      await store.setJSON(STATUS_KEY, {
        running: false, done: false, startedAt: new Date().toISOString(),
        error: `The background worker returned ${res.status} rather than 202. Background functions may not be enabled for this site.`,
      });
      return json({
        started: false,
        error: `Could not start the background refresh (HTTP ${res.status}).`,
        hint: "Netlify background functions require a paid plan. Without one, the hourly sync is the only way this data refreshes.",
      }, 502);
    }
  } catch (err) {
    await store.setJSON(STATUS_KEY, {
      running: false, done: false, startedAt: new Date().toISOString(), error: err.message,
    });
    return json({ started: false, error: err.message }, 502);
  }

  return json({
    started: true,
    force,
    note: "Refresh started. It runs in the background — poll this endpoint for progress.",
  });
};
