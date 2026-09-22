// netlify/functions/_shared/field-fx.mjs
//
// Live market rates for the Field Budget planning rates.
//
// A leg's planning rate is typed in by hand when a budget is set up and then
// never touched. Nothing refreshes it and nothing notices when it drifts, so a
// rate entered in June quietly skews every unreconciled line on that leg in
// October. This module exists to do two small things about that: fill the box
// with today's rate when a budget is created, and say so on the card when the
// stored rate has wandered away from the market.
//
// It does NOT change how anything is converted. The stored planning rate stays
// the rate entries are measured against — recalculating history when the market
// moves is exactly the behaviour FIELD-BUDGET.md rules out ("change a rate in
// April and February's balances stay put"). This is a prompt to a human, not an
// automatic correction.
//
// Source is the ECB reference series via Frankfurter (no key, published on
// TARGET business days), falling back to exchangerate-api's open endpoint —
// same pair as cash-forecast's _shared/cash-fx.mjs. That one is built around a
// single pair with trailing averages and a blob history, because a forecast
// plans at an average. Here one spot reading across several currencies is all
// that's wanted, so this fetches once for every currency on the page rather
// than once per pair.
//
// Neither source is a dealing rate — the bank's spread sits on top — so a
// fetched rate is a better starting guess than a remembered one, not a settled
// figure. `actual_nzd` at reconciliation remains the only exact number.

const PRIMARY = "https://api.frankfurter.dev/v1/latest";
const FALLBACK = "https://open.er-api.com/v6/latest";

/** How far a stored rate may drift before the card says something. */
export const DRIFT_THRESHOLD = 0.05;

const CODE = /^[A-Z]{3}$/;

export function cleanCodes(codes) {
  return [...new Set((codes || [])
    .map((c) => String(c || "").trim().toUpperCase())
    .filter((c) => CODE.test(c)))].sort();
}

/**
 * Units of `to` per 1 unit of `from`, from a table quoted against one base.
 *
 * `rates` is whatever the market base buys — { USD: 0.58, FJD: 1.28 } against
 * NZD. The market base itself is implicitly 1, so it doesn't need to appear.
 * Returns null rather than a guess when either leg is missing: a wrong cross
 * rate looks exactly like a right one.
 */
export function crossRate(rates, from, to, marketBase) {
  const f = String(from || "").toUpperCase();
  const t = String(to || "").toUpperCase();
  const mb = String(marketBase || "").toUpperCase();
  if (!CODE.test(f) || !CODE.test(t)) return null;
  if (f === t) return 1;

  const at = (code) => {
    if (code === mb) return 1;
    const v = Number((rates || {})[code]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const a = at(f);
  const b = at(t);
  if (a === null || b === null) return null;
  return b / a;
}

/**
 * How far a stored planning rate sits from the market.
 *
 * `pct` is signed and relative to the live rate: positive means the stored rate
 * is high, which means spend converts to FEWER base units than it really costs
 * — the direction that flatters a budget, and so the one worth catching.
 */
export function rateDrift(stored, live) {
  const s = Number(stored);
  const l = Number(live);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(l) || l <= 0) return null;
  return { stored: s, live: l, pct: (s - l) / l };
}

export function isDrifted(stored, live, threshold = DRIFT_THRESHOLD) {
  const d = rateDrift(stored, live);
  return d !== null && Math.abs(d.pct) >= threshold;
}

/** Shape a Frankfurter or exchangerate-api body into one form, or null. */
export function parseSpot(body, base, source) {
  const raw = body?.rates;
  if (!raw || typeof raw !== "object") return null;
  const rates = {};
  for (const [code, value] of Object.entries(raw)) {
    const c = String(code).toUpperCase();
    const n = Number(value);
    if (CODE.test(c) && Number.isFinite(n) && n > 0) rates[c] = n;
  }
  if (!Object.keys(rates).length) return null;
  return {
    base: String(base).toUpperCase(),
    date: body.date || body.time_last_update_utc?.slice(0, 16) || new Date().toISOString().slice(0, 10),
    rates,
    source,
  };
}

// One spot table serves a whole page, so a warm container holding it for a few
// hours turns every dashboard load after the first into no outbound call at
// all. Rates that move within a morning don't change a planning decision.
const TTL_MS = 6 * 60 * 60 * 1000;
const _cache = new Map();

/**
 * Today's rates for `symbols`, quoted against `base`.
 *
 * Returns null on any failure. Every caller treats FX as decoration: the page
 * must load, and a budget must be editable, when the rate service is down.
 */
export async function fetchSpot(base, symbols, { fetchImpl = fetch, now = Date.now } = {}) {
  const b = String(base || "NZD").toUpperCase();
  const wanted = cleanCodes(symbols).filter((c) => c !== b);
  if (!CODE.test(b) || !wanted.length) return null;

  const key = `${b}:${wanted.join(",")}`;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;

  const attempts = [
    { url: `${PRIMARY}?base=${b}&symbols=${wanted.join(",")}`, source: "ECB via Frankfurter" },
    { url: `${FALLBACK}/${b}`, source: "exchangerate-api (spot)" },
  ];

  for (const a of attempts) {
    try {
      const res = await fetchImpl(a.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const parsed = parseSpot(await res.json(), b, a.source);
      if (!parsed) continue;
      // The fallback returns every currency it knows; keep only what was asked
      // for, so the payload doesn't quietly grow by 160 codes.
      parsed.rates = Object.fromEntries(
        Object.entries(parsed.rates).filter(([c]) => wanted.includes(c)));
      if (!Object.keys(parsed.rates).length) continue;
      _cache.set(key, { at: now(), value: parsed });
      return parsed;
    } catch {
      // Try the next source; a rate lookup must never fail a page load.
    }
  }
  return null;
}

/** Test seam — the cache is process-wide and would otherwise leak between cases. */
export function _resetFxCache() {
  _cache.clear();
}
