/**
 * Live exchange rates, and the trailing average used as the planning rate.
 *
 * The workbook hardcoded 1.65 in seven cells while its Assumptions sheet said
 * 1.60. Neither was ever revisited. Here the planning rate is derived from the
 * actual market over a window you choose, refreshed daily, with the observed
 * high and low kept alongside it so the rate risk is visible rather than
 * implied.
 *
 * Source is the ECB reference series via Frankfurter (no key, published daily
 * on TARGET business days), falling back to exchangerate-api's open endpoint.
 * Neither is a dealing rate — your bank's spread sits on top — so treat the
 * planning rate as the mid you plan against, not the rate you will get.
 */
import { getStore } from "@netlify/blobs";
const PRIMARY = "https://api.frankfurter.dev/v1";
const FALLBACK = "https://open.er-api.com/v6/latest";
/** Resolve which number the forecast should actually plan at. */
export function planningRate(summary, source, manualRate) {
    if (!summary || source === "manual")
        return manualRate;
    switch (source) {
        case "avg30": return summary.avg30;
        case "avg60": return summary.avg60;
        case "avg90": return summary.avg90;
        case "current": return summary.current;
        default: return manualRate;
    }
}
function mean(xs) {
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function isoDaysAgo(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}
/**
 * Pull ~90 days of daily rates and reduce them to a summary.
 *
 * Trailing windows are counted in OBSERVATIONS, not calendar days — the ECB
 * publishes on business days only, so a "30 day" average over calendar days
 * would quietly be built from about 21 readings. Taking the last N published
 * rates is what the label actually promises.
 */
export async function fetchRateSummary(from = "USD", to = "NZD") {
    const pair = `${from}${to}`;
    try {
        const url = `${PRIMARY}/${isoDaysAgo(130)}..?base=${from}&symbols=${to}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
        if (!res.ok)
            throw new Error(`Frankfurter ${res.status}`);
        const json = await res.json();
        const series = Object.entries(json.rates ?? {})
            .map(([date, r]) => ({ date, rate: Number(r[to]) }))
            .filter((o) => Number.isFinite(o.rate) && o.rate > 0)
            .sort((a, b) => a.date.localeCompare(b.date));
        if (series.length < 5)
            throw new Error("Frankfurter returned too few observations");
        const rates = series.map((o) => o.rate);
        const last = (n) => rates.slice(-n);
        const last90 = last(90);
        return {
            pair,
            current: rates[rates.length - 1],
            avg30: round(mean(last(30))),
            avg60: round(mean(last(60))),
            avg90: round(mean(last90)),
            low90: round(Math.min(...last90)),
            high90: round(Math.max(...last90)),
            observations: series.length,
            asOf: series[series.length - 1].date,
            source: "ECB via Frankfurter",
        };
    }
    catch {
        // Spot only. Averages collapse to the spot rate and `degraded` says so, so
        // the dashboard never presents a single reading as a 90-day average.
        const res = await fetch(`${FALLBACK}/${from}`, { signal: AbortSignal.timeout(12_000) });
        if (!res.ok)
            throw new Error(`No FX source available (${res.status})`);
        const json = await res.json();
        const rate = Number(json?.rates?.[to]);
        if (!Number.isFinite(rate))
            throw new Error(`No ${to} rate in fallback response`);
        return {
            pair, current: rate,
            avg30: rate, avg60: rate, avg90: rate, low90: rate, high90: rate,
            observations: 1,
            asOf: new Date().toISOString().slice(0, 10),
            source: "exchangerate-api (spot only)",
            degraded: true,
        };
    }
}
function round(n) {
    return Math.round(n * 10_000) / 10_000;
}
/* ---------------- storage ---------------- */
function store() {
    return getStore({ name: "cash-fx-rates", consistency: "strong" });
}
export async function saveRateSummary(summary) {
    const s = store();
    await s.setJSON(`summary/${summary.pair}`, summary);
    // Daily snapshot, so you can see later what you were planning at back then.
    await s.setJSON(`history/${summary.pair}/${summary.asOf}`, summary);
}
export async function loadRateSummary(pair = "USDNZD") {
    return (await store().get(`summary/${pair}`, { type: "json" }));
}
