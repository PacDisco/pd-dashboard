// netlify/functions/_shared/cash-cost-curve.mjs
//
// Turn tagged spend into a cost curve per season.
//
// WHY THIS IS NOT A PROBE
// -----------------------
// Every previous step here has ended with "run this diagnostic and send me the
// output". That works once. Four times in a row it is a bad workflow: it makes
// one person a courier for their own data, and it means the answer only exists
// in a conversation rather than on the page.
//
// So this derives the curves server-side, next to the figures they would
// replace, and reports its own confidence. Nobody has to relay anything.
//
// THE ANCHOR PROBLEM, STATED HONESTLY
// -----------------------------------
// Spend is tagged by SEASON in Xero, so a season's costs are known as one
// stream. But a curve is "how far before departure did this money go out", and
// a season contains several programs departing on different dates. There is one
// stream and several departures, so a single anchor date has to be chosen.
//
// This uses the revenue-weighted mean departure, and REPORTS the spread. A
// season whose programs all leave within a fortnight gives a sharp curve; one
// spread over two months gives a blurred one, and the spread is published so
// that blur is visible rather than implied.

const SEASON_WORDS = ["fall", "spring", "summer", "autumn", "winter"];

/** "Fall 26", "FALL2026", "Fall-26" → { season: "Fall", year: 2026 }. */
export function parseSeasonOption(option) {
  const raw = String(option ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const word = SEASON_WORDS.find((w) => lower.includes(w));
  if (!word) return null;

  // Two or four digits, anywhere after the season word. "Fall 26" and
  // "Fall 2026" are the same season; 26 means 2026, not 1926.
  const m = lower.match(/(\d{4}|\d{2})(?!\d)/);
  if (!m) return { season: capitalise(word), year: null, raw };
  const n = Number(m[1]);
  const year = m[1].length === 4 ? n : 2000 + n;
  return { season: capitalise(word), year, raw };
}

function capitalise(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * When each season-year actually departs, from the programs in the model.
 *
 * Weighted by revenue rather than a simple mean: a season with one large cohort
 * and three small ones departs, for cash purposes, when the large one does.
 *
 * @returns {Record<string, {season, year, anchor, spreadDays, programs, revenue}>}
 */
export function seasonAnchors(programs = []) {
  const groups = new Map();

  for (const p of programs) {
    if (!p?.season || !p?.startDate) continue;
    const departure = new Date(`${p.startDate}T00:00:00Z`);
    if (Number.isNaN(departure.getTime())) continue;
    // A season's YEAR is the calendar year it departs in, which is how the
    // tracking option is named.
    const year = departure.getUTCFullYear();
    const key = `${p.season} ${year}`;
    const revenue = Math.max(0, Number(p.paxForecast ?? p.pax ?? 0) * Number(p.price ?? 0)) || 1;

    if (!groups.has(key)) groups.set(key, { season: p.season, year, rows: [] });
    groups.get(key).rows.push({ t: departure.getTime(), revenue, name: p.name });
  }

  const out = {};
  for (const [key, g] of groups) {
    const totalRevenue = g.rows.reduce((s, r) => s + r.revenue, 0);
    const mean = g.rows.reduce((s, r) => s + r.t * r.revenue, 0) / totalRevenue;
    const times = g.rows.map((r) => r.t);
    out[key] = {
      season: g.season,
      year: g.year,
      anchor: new Date(mean).toISOString().slice(0, 10),
      // How far apart the programs in this season depart. A wide spread means
      // the curve is an average over departures that are not aligned, and the
      // reader should know that before adopting it.
      spreadDays: Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000),
      programs: g.rows.map((r) => r.name),
      revenue: Math.round(totalRevenue),
    };
  }
  return out;
}

/** Months between an anchor date and a "YYYY-MM", signed. Negative = before. */
export function offsetFromAnchor(anchorISO, key) {
  const [ay, am] = anchorISO.split("-").map(Number);
  const [ky, km] = key.split("-").map(Number);
  return (ky * 12 + km) - (ay * 12 + am);
}

/**
 * Build one observation per season-year from the stored transaction months.
 *
 * @param txMonths  [{ month: "2026-04", byCategory: { Season: { "Fall 26": 1234 } } }]
 * @param anchors   from seasonAnchors()
 * @param category  which tracking category holds the season, e.g. "Season"
 */
export function seasonObservations(txMonths = [], anchors = {}, category = "Season") {
  const byKey = new Map();
  const unmatched = new Map();

  for (const m of txMonths) {
    const bucket = m?.byCategory?.[category];
    if (!bucket || !m.month) continue;

    for (const [option, amount] of Object.entries(bucket)) {
      if (!amount) continue;
      const parsed = parseSeasonOption(option);
      const key = parsed?.year ? `${parsed.season} ${parsed.year}` : null;

      if (!key || !anchors[key]) {
        // A tagged option nobody can place against a departure date. Reported,
        // never quietly folded into a season it resembles.
        unmatched.set(option, (unmatched.get(option) ?? 0) + amount);
        continue;
      }
      if (!byKey.has(key)) byKey.set(key, { programId: key, departure: anchors[key].anchor, byMonth: {} });
      const obs = byKey.get(key);
      obs.byMonth[m.month] = (obs.byMonth[m.month] ?? 0) + amount;
    }
  }

  return {
    observations: [...byKey.values()],
    unmatchedOptions: Object.fromEntries(
      [...unmatched.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])),
  };
}

/**
 * A curve for one season, from its observations across years.
 *
 * Shares by month offset, negative meaning before departure. Reports what it is
 * built on so the reader can judge it: how many season-years, how much money,
 * and whether the window is COMPLETE — a season observed only before its
 * departure gives a ramp with no tail, and adopting that would replace one
 * invention with another.
 */
export function deriveSeasonCurve(observations = [], { minMonths = 6, minTotal = 25_000 } = {}) {
  const byOffset = new Map();
  let total = 0;
  let minOffset = Infinity;
  let maxOffset = -Infinity;
  const monthsSeen = new Set();

  for (const obs of observations) {
    for (const [key, amount] of Object.entries(obs.byMonth ?? {})) {
      if (!Number.isFinite(amount) || amount === 0) continue;
      const offset = offsetFromAnchor(obs.departure, key);
      byOffset.set(offset, (byOffset.get(offset) ?? 0) + amount);
      total += amount;
      monthsSeen.add(key);
      if (offset < minOffset) minOffset = offset;
      if (offset > maxOffset) maxOffset = offset;
    }
  }

  if (!total) {
    return { offsets: [], total: 0, adoptable: false, reasons: ["no tagged spend for this season"] };
  }

  const offsets = [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([monthOffset, amount]) => ({
      monthOffset,
      share: Math.round((amount / total) * 10_000) / 10_000,
      amount: Math.round(amount),
    }));

  const reasons = [];
  // A season seen only before departure has no tail. This is the specific trap:
  // FY26/27 alone covers April to August against a 1 September Fall departure,
  // so every offset is negative and the curve looks confident while describing
  // half a cycle.
  if (maxOffset < 1) reasons.push("no spend observed at or after departure — the tail is missing");
  if (monthsSeen.size < minMonths) reasons.push(`only ${monthsSeen.size} months of spend observed`);
  if (total < minTotal) reasons.push(`only ${Math.round(total).toLocaleString("en-NZ")} of spend observed`);
  if (observations.length < 1) reasons.push("no observations");

  return {
    offsets,
    total: Math.round(total),
    seasonYears: observations.length,
    monthsObserved: monthsSeen.size,
    window: { first: minOffset, last: maxOffset },
    adoptable: reasons.length === 0,
    reasons,
  };
}

/** Every season, plus the model's current curve for comparison. */
export function deriveAllSeasonCurves({ txMonths = [], programs = [], category = "Season", current = null } = {}) {
  const anchors = seasonAnchors(programs);
  const { observations, unmatchedOptions } = seasonObservations(txMonths, anchors, category);

  // Group season-years into seasons: Fall 25 and Fall 26 are two observations
  // of the same seasonal rhythm, which is the whole reason for pulling a second
  // year of history.
  const bySeason = new Map();
  for (const obs of observations) {
    const season = anchors[obs.programId]?.season;
    if (!season) continue;
    if (!bySeason.has(season)) bySeason.set(season, []);
    bySeason.get(season).push(obs);
  }

  const seasons = {};
  for (const [season, obs] of bySeason) {
    seasons[season] = {
      ...deriveSeasonCurve(obs),
      observedYears: obs.map((o) => o.programId),
      anchors: obs.map((o) => ({ key: o.programId, departs: o.departure, spreadDays: anchors[o.programId]?.spreadDays ?? null })),
    };
  }

  return {
    seasons,
    anchors,
    unmatchedOptions,
    current: current ?? null,
  };
}

export default {
  parseSeasonOption, seasonAnchors, offsetFromAnchor,
  seasonObservations, deriveSeasonCurve, deriveAllSeasonCurves,
};

/* ------------------------------------------------------------------ *
 * The simpler answer: a calendar profile
 * ------------------------------------------------------------------ */

/**
 * Twelve shares — what fraction of a year's program cost goes out in each
 * fiscal month — measured from the P&L's Cost of Sales.
 *
 * WHY THIS IS USUALLY THE BETTER TRADE
 * ------------------------------------
 * Everything above depends on tying each payment to a program, which depends on
 * whether someone filled in a tracking tag. That is a dependency nobody
 * controls, and it fails quietly when the answer is "sometimes".
 *
 * This depends instead on the calendar repeating — an assumption anyone can
 * check, and one that is nearly free to re-check each year. It is measured on
 * 100% of program cost rather than on whatever share happens to be tagged.
 *
 * SHAPE FROM HISTORY, AMOUNT FROM THE MODEL. The profile is shares, never
 * dollars: the forecast supplies the year's total program cost from its own pax
 * and per-pax costs, and this decides when it leaves. So a year with twice the
 * enrolments spends twice as much on the same rhythm, and only the rhythm is
 * assumed stable.
 *
 * WHAT IT CANNOT DO, said plainly: it does not know about departure dates. Move
 * Fall from September to October and the real spend moves with it while this
 * profile does not. It is an assumption about the calendar, not a model of
 * cause — which is exactly why each year is reported separately below, so a
 * changing shape is visible rather than averaged away.
 *
 * @param monthsByYear  { 2025: { "2025-04": 1234, ... }, 2026: {...} }
 */
export function monthlyCostProfile(monthsByYear = {}, { minYearTotal = 50_000 } = {}) {
  const FISCAL = ["04", "05", "06", "07", "08", "09", "10", "11", "12", "01", "02", "03"];
  const years = Object.keys(monthsByYear).map(Number).sort();

  const perYear = [];
  for (const fy of years) {
    const byMonth = monthsByYear[fy] ?? {};
    const slots = FISCAL.map((mm, i) => {
      // April to December are the fiscal year's own calendar year; January to
      // March are the next one.
      const y = i < 9 ? fy : fy + 1;
      return byMonth[`${y}-${mm}`] ?? 0;
    });
    const total = slots.reduce((s, v) => s + v, 0);
    const monthsWithData = slots.filter((v) => v !== 0).length;
    perYear.push({
      fiscalYear: fy,
      total: Math.round(total),
      monthsWithData,
      complete: monthsWithData === 12,
      shares: total > 0 ? slots.map((v) => Math.round((v / total) * 10_000) / 10_000) : slots.map(() => 0),
      amounts: slots.map((v) => Math.round(v)),
    });
  }

  // Only COMPLETE years can define a shape. A part-year's shares describe the
  // months it happens to contain and say nothing about the rest — averaging it
  // in would quietly tilt the profile toward whichever months were observed.
  const usable = perYear.filter((y) => y.complete && y.total >= minYearTotal);

  const shares = usable.length
    ? Array.from({ length: 12 }, (_, i) =>
        Math.round((usable.reduce((s, y) => s + y.shares[i], 0) / usable.length) * 10_000) / 10_000)
    : null;

  const reasons = [];
  if (!perYear.length) reasons.push("no program cost recorded");
  else if (!usable.length) {
    const best = perYear.reduce((a, b) => (b.monthsWithData > a.monthsWithData ? b : a));
    reasons.push(`no complete fiscal year — the fullest has ${best.monthsWithData} of 12 months`);
  }

  // Two years that disagree are worth knowing about: it means the calendar
  // assumption this rests on is not actually holding.
  let maxYearGapPct = null;
  if (usable.length > 1 && shares) {
    maxYearGapPct = Math.round(Math.max(...usable.flatMap(
      (y) => y.shares.map((v, i) => Math.abs(v - shares[i])))) * 1000) / 10;
    if (maxYearGapPct > 8) {
      reasons.push(`the observed years disagree by up to ${maxYearGapPct} points in a single month`);
    }
  }

  return {
    shares,
    fiscalMonths: ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"],
    perYear,
    yearsUsed: usable.map((y) => y.fiscalYear),
    maxYearGapPct,
    adoptable: Boolean(shares) && reasons.length === 0,
    reasons,
  };
}

/* ------------------------------------------------------------------ *
 * Before, during, after — measured
 * ------------------------------------------------------------------ */

/**
 * A season's calendar window: when its earliest program starts, when its latest
 * one starts, and when they all finish.
 *
 * WHY THE END DATE IS THE INTERESTING ONE
 * ---------------------------------------
 * Pacific Discovery's programs in a season END on the same day but START on
 * staggered dates. The model applies one offset curve anchored to each
 * program's start, which shifts a later-starting program's whole cost shape
 * later — including the delivery spend, which in reality has to finish when the
 * group goes home.
 *
 * So a program starting a month later is a month SHORTER, and its delivery cost
 * should compress rather than slide. `endDate` is already on every program and
 * the engine has never read it.
 */
export function seasonWindows(programs = []) {
  const groups = new Map();

  for (const p of programs) {
    if (!p?.season || !p?.startDate) continue;
    const year = Number(p.startDate.slice(0, 4));
    const key = `${p.season} ${year}`;
    if (!groups.has(key)) groups.set(key, { season: p.season, year, starts: [], ends: [], names: [] });
    const g = groups.get(key);
    g.starts.push(p.startDate);
    if (p.endDate) g.ends.push(p.endDate);
    g.names.push(p.name);
  }

  const out = {};
  for (const [key, g] of groups) {
    const firstStart = g.starts.slice().sort()[0];
    const lastStart = g.starts.slice().sort().reverse()[0];
    const end = g.ends.length ? g.ends.slice().sort().reverse()[0] : null;
    out[key] = {
      season: g.season, year: g.year,
      firstStart, lastStart, end,
      // How staggered the starts are. With a common end date this is exactly
      // how much shorter the last program is than the first.
      staggerDays: Math.round(
        (new Date(`${lastStart}T00:00:00Z`) - new Date(`${firstStart}T00:00:00Z`)) / 86_400_000),
      programs: g.names,
      // Without an end date a season cannot be split at all, and saying so is
      // better than assuming a duration.
      hasEnd: Boolean(end),
    };
  }
  return out;
}

/** "YYYY-MM" → the first and last day of that month, as comparable strings. */
function monthBounds(key) {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, "0")}` };
}

/**
 * How a season's cost splits between the run-up, delivery, and after it ends.
 *
 * A month counts as DURING if the season is running for any part of it, BEFORE
 * if it ends before the first program starts, and AFTER if it begins after the
 * last one finishes. Whole months, because that is the granularity the spend is
 * stored at — a season starting mid-September has September as a delivery month.
 *
 * WHY A SPLIT RATHER THAN A CURVE
 * -------------------------------
 * A full offset curve needs most of the spend tagged to be meaningful, because
 * every month's share is a separate number resting on that month's tagged
 * subset. Three numbers are far more forgiving: if two-thirds of spend is tagged
 * and that two-thirds is representative, the split is still informative and the
 * coverage caveat is one sentence rather than twelve.
 */
export function deliverySplit(txMonths = [], windows = {}, category = "Season") {
  const bySeasonYear = new Map();
  let untagged = 0;
  let noWindow = 0;

  for (const m of txMonths) {
    const bucket = m?.byCategory?.[category];
    if (!bucket || !m.month) { untagged += m?.totalOut ?? 0; continue; }

    for (const [option, amount] of Object.entries(bucket)) {
      if (!amount) continue;
      const parsed = parseSeasonOption(option);
      const key = parsed?.year ? `${parsed.season} ${parsed.year}` : null;
      const w = key ? windows[key] : null;
      if (!w || !w.hasEnd) { noWindow += amount; continue; }

      const { from, to } = monthBounds(m.month);
      // Overlap test against the season's own window.
      const phase = to < w.firstStart ? "before"
        : from > w.end ? "after"
        : "during";

      if (!bySeasonYear.has(key)) {
        bySeasonYear.set(key, {
          key, season: w.season, year: w.year,
          firstStart: w.firstStart, lastStart: w.lastStart, end: w.end,
          staggerDays: w.staggerDays,
          before: 0, during: 0, after: 0,
          deliveryMonths: new Set(), runUpMonths: new Set(),
        });
      }
      const row = bySeasonYear.get(key);
      row[phase] += amount;
      if (phase === "during") row.deliveryMonths.add(m.month);
      if (phase === "before") row.runUpMonths.add(m.month);
    }
  }

  const seasonYears = [...bySeasonYear.values()].map((r) => {
    const total = r.before + r.during + r.after;
    return {
      key: r.key, season: r.season, year: r.year,
      firstStart: r.firstStart, lastStart: r.lastStart, end: r.end,
      staggerDays: r.staggerDays,
      total: Math.round(total),
      shares: total > 0 ? {
        before: Math.round((r.before / total) * 1000) / 1000,
        during: Math.round((r.during / total) * 1000) / 1000,
        after: Math.round((r.after / total) * 1000) / 1000,
      } : null,
      amounts: { before: Math.round(r.before), during: Math.round(r.during), after: Math.round(r.after) },
      deliveryMonths: r.deliveryMonths.size,
      runUpMonths: r.runUpMonths.size,
      // A season observed only in its run-up cannot say how much falls during
      // delivery — the same half-a-cycle trap, and it has to be refused here too.
      complete: r.during > 0 || r.after > 0,
    };
  }).sort((a, b) => (a.key < b.key ? -1 : 1));

  // Weighted across every complete season-year: a big season should count for
  // more than a small one.
  const usable = seasonYears.filter((s) => s.complete && s.total > 0);
  const weightTotal = usable.reduce((s, r) => s + r.total, 0);
  const overall = weightTotal > 0 ? {
    before: Math.round(usable.reduce((s, r) => s + r.shares.before * r.total, 0) / weightTotal * 1000) / 1000,
    during: Math.round(usable.reduce((s, r) => s + r.shares.during * r.total, 0) / weightTotal * 1000) / 1000,
    after: Math.round(usable.reduce((s, r) => s + r.shares.after * r.total, 0) / weightTotal * 1000) / 1000,
  } : null;

  const reasons = [];
  if (!usable.length) reasons.push("no season observed through its delivery period");
  if (noWindow > 0) reasons.push(`${Math.round(noWindow).toLocaleString("en-NZ")} tagged to a season with no end date in the model`);

  return {
    overall,
    seasonYears,
    seasonYearsUsed: usable.map((s) => s.key),
    untaggedSpend: Math.round(untagged),
    taggedToUnknownSeason: Math.round(noWindow),
    adoptable: Boolean(overall) && usable.length > 0,
    reasons,
  };
}
