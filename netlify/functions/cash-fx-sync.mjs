/**
 * Daily exchange-rate refresh.
 *
 * Pulls the USD/NZD series, stores the trailing averages, and keeps a dated
 * snapshot so you can see later what rate you were planning at.
 *
 * Runs at 06:00 UTC — after the ECB's daily publication, and before anyone in
 * New Zealand opens the dashboard.
 */
import { fetchRateSummary, saveRateSummary } from "./_shared/cash-fx.mjs";
export default async (_req, _context) => {
    const summary = await fetchRateSummary("USD", "NZD");
    await saveRateSummary(summary);
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
    schedule: "0 6 * * *",
};
