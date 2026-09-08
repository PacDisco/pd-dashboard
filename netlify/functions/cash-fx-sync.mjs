/**
 * Daily exchange-rate refresh.
 *
 * Pulls the USD/NZD series, stores the trailing averages, and keeps a dated
 * snapshot so you can see later what rate you were planning at.
 *
 * Runs at 20:00 UTC, which is 8am the next morning in New Zealand.
 *
 * The time is chosen around the ECB rather than the clock: it snapshots rates
 * at 14:15 CET and publishes around 16:00 CET, so roughly 14:00-15:00 UTC
 * depending on the season. Anything earlier in the UTC day picks up the
 * PREVIOUS business day's rate. 20:00 UTC is comfortably after publication and
 * still lands before the NZ working day starts.
 */
import { fetchRateSummary, saveRateSummary } from "./_shared/cash-fx.mjs";
export default async (_req, _context) => {
    const summary = await fetchRateSummary("USD", "NZD");
    await saveRateSummary(summary);

    // Scheduled functions return into the void — nothing renders the response
    // body in the Netlify log. This line is the only durable record that the
    // run happened and what it stored, so keep it.
    console.log(
      `[cash-fx-sync] ${summary.pair} current=${summary.current} ` +
        `avg30=${summary.avg30} avg60=${summary.avg60} avg90=${summary.avg90} ` +
        `range=${summary.low90}-${summary.high90} obs=${summary.observations} ` +
        `asOf=${summary.asOf} source="${summary.source}"` +
        (summary.degraded ? " DEGRADED=spot-only" : ""),
    );
    return Response.json({
        ok: true,
        pair: summary.pair,
        current: summary.current,
        avg90: summary.avg90,
        observations: summary.observations,
        degraded: summary.degraded ?? false,
    });
};
export const config = {
    schedule: "0 20 * * *",
};
