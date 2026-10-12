/**
 * Fiscal-year cash flow report — the data, not the drawing.
 *
 * Takes a forecast exactly as the page displays it (the output of
 * buildForecast, server or local) and cuts one April–March year out of the
 * horizon, with totals, notes and the programs departing in it. report-pdf.js
 * draws it; this module is pure so the arithmetic can be tested in node without
 * a browser or a PDF library.
 *
 * WHY THE TOTALS ARE RECOMPUTED HERE
 * ----------------------------------
 * forecast.totals covers the MODEL'S fiscal year only — the first twelve
 * months. The horizon runs two years or more, and a report for FY27/28 built
 * from forecast.totals would print the wrong year's numbers under the right
 * year's title. So every figure in a report comes from that report's own
 * twelve months.
 *
 * WHY BALANCE ROWS DO NOT SUM
 * ---------------------------
 * Cash in and cash out are flows: the year total is the sum. The NZD account,
 * the USD balance and the total position are balances: the year "total" is the
 * 31 March closing figure. Summing twelve closing balances produces a number
 * that means nothing and looks authoritative, so each row says which it is.
 */

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const fyLabel = (y) => `FY ${y}/${String(y + 1).slice(2)}`;
export const fyShort = (y) => `FY${String(y).slice(2)}-${String(y + 1).slice(2)}`;

/**
 * The complete fiscal years inside a forecast's horizon.
 *
 * Only whole years: a report for a year with five months in it would show
 * year totals that are not year totals. The horizon is always at least two
 * whole years, so there is always something to offer.
 */
export function fiscalYearsIn(forecast) {
  const fy0 = forecast.fiscalYearStartYear;
  const n = Math.floor(forecast.months.length / 12);
  const recognised = (forecast.programs ?? [])
    .map((c) => c.recognitionIndex).filter((i) => typeof i === "number");
  return Array.from({ length: n }, (_, i) => {
    const startIndex = i * 12;
    const startYear = fy0 + i;
    return {
      startYear,
      label: fyLabel(startYear),
      range: `Apr ${startYear} – Mar ${startYear + 1}`,
      startIndex,
      isModelYear: i === 0,
      // No program departs in the year: still exportable, but the picker and
      // the PDF say so, because a report of overheads-only months travels
      // further than the caveat that should go with it. Judged on departures
      // (the recognition month), not on cash — a year can carry the tail of
      // last season's supplier payments and still have nothing entered in it.
      noPrograms: !recognised.some((r) => r >= startIndex && r < startIndex + 12),
    };
  });
}

function indexOfKey(forecast, key) {
  if (!key) return null;
  const i = forecast.months.findIndex((m) => m.key === key);
  return i < 0 ? null : i;
}

const sum = (xs) => xs.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);

/**
 * One fiscal year, ready to draw.
 *
 * @param forecast      buildForecast output — whatever the page is showing
 * @param startYear     the April year of the fiscal year to report
 * @param opts.forecastOnly  the server's no-actuals run, for the variance row
 * @param opts.programs      assumptions.programs, for departure dates
 * @param opts.buffer        minimum NZD balance, for the buffer note
 */
export function fiscalYearReport(forecast, startYear, { forecastOnly = null, programs = [], buffer = 0 } = {}) {
  const years = fiscalYearsIn(forecast);
  const year = years.find((y) => y.startYear === startYear);
  if (!year) {
    throw new Error(`${fyLabel(startYear)} is not a complete year in this forecast (${
      years.map((y) => y.label).join(", ") || "none"}).`);
  }
  const months = forecast.months.slice(year.startIndex, year.startIndex + 12);
  const first = months[0];
  const last = months[11];

  /* ---- the table: the same rows as the Cash flow tab, in the same order ---- */

  // Mirrors forecastView: one Revenue row when the receipts curve is driving
  // cash in, the deposits/balances split only for a model still using it.
  // Decided on the whole horizon, not this year, so a runway year with no
  // receipts still has the same row shape as the year before it.
  const usingCurve = forecast.months.some((m) => Math.abs(m.revenueIn) > 0.5);

  // [label, getter, style, kind, realWhenClosed]
  //   kind "flow"    — year column is the sum
  //   kind "balance" — year column is the 31 March figure
  const defs = [
    ...(usingCurve
      ? [["Revenue in", (m) => m.revenueIn, "", "flow", false]]
      : [["Deposits in", (m) => m.depositsIn, "", "flow", false],
         ["Balances in", (m) => m.balancesIn, "", "flow", false]]),
    ["Cash in", (m) => m.cashIn, "strong", "flow", true],
    ["Program costs", (m) => -m.programCostsOut, "", "flow", false],
    ["Overheads", (m) => -m.overheads, "", "flow", false],
    ["Capital", (m) => -m.capital, "", "flow", false],
    ["Tax", (m) => -m.tax, "", "flow", false],
    ["Cash out", (m) => -m.cashOut, "strong", "flow", true],
    ["Net movement", (m) => m.net, "strong", "flow", true],
    ["section", "Treasury"],
    ["USD received", (m) => m.fxIn, "", "flow", true],
    ["USD converted", (m) => (m.fxConverted === null ? null : -m.fxConverted), "", "flow", true],
    ["USD balance", (m) => m.fxClosing, "strong", "balance", true],
    ["NZD from conversion", (m) => m.baseFromConversion, "", "flow", true],
    ["NZD account", (m) => m.baseClosing, "rule", "balance", true],
    ["Total position (NZD)", (m) => m.closing, "muted", "balance", true],
    ["Revenue recognised", (m) => m.recognisedRevenue, "muted", "flow", false],
    ["Deferred revenue", (m) => m.deferredRevenueBalance, "muted", "balance", false],
  ];

  const rows = defs.map((d) => {
    if (d[0] === "section") return { section: d[1] };
    const [label, get, style, kind, real] = d;
    const values = months.map((m) => {
      const v = get(m);
      return v === undefined ? null : v;
    });
    const known = values.filter((v) => typeof v === "number");
    const total = kind === "balance"
      ? values[11]
      : known.length ? sum(known) : null;
    return {
      label, style, kind, realWhenClosed: real, values, total,
      // A flow total with gaps in it is a total of the months that could be
      // derived, and must say so rather than pass for the year.
      partialTotal: kind === "flow" && known.length > 0 && known.length < values.length,
    };
  });

  /* Forecast versus actual on the NZD account, closed months only. */
  const actualCount = months.filter((m) => m.isActual).length;
  if (actualCount && forecastOnly?.months) {
    const byKey = Object.fromEntries(forecastOnly.months.map((m) => [m.key, m]));
    const values = months.map((m) => (m.isActual && byKey[m.key]
      ? m.baseClosing - byKey[m.key].baseClosing : null));
    if (values.some((v) => v !== null)) {
      rows.push({ section: "Variance" });
      rows.push({
        label: "NZD vs forecast", style: "strong", kind: "balance", realWhenClosed: true,
        values, total: [...values].reverse().find((v) => v !== null) ?? null,
        partialTotal: false, variance: true,
      });
    }
  }

  /* ---- headline figures ---- */

  const lowest = months.reduce((min, m) => (m.baseClosing < min.baseClosing ? m : min), months[0]);
  const firstNegative = months.find((m) => m.baseClosing < 0) ?? null;
  const firstUnderBuffer = buffer > 0 ? months.find((m) => m.baseClosing < buffer) ?? null : null;
  const convertedKnown = months.map((m) => m.fxConverted).filter((v) => typeof v === "number");

  const summary = {
    openingBase: first.baseOpening ?? (first.baseClosing - first.net),
    cashIn: sum(months.map((m) => m.cashIn)),
    cashOut: sum(months.map((m) => m.cashOut)),
    net: sum(months.map((m) => m.net)),
    closingBase: last.baseClosing,
    lowestBase: lowest.baseClosing,
    lowestBaseMonth: lowest.label,
    fxConverted: sum(convertedKnown),
    fxConvertedPartial: convertedKnown.length < 12,
    usdHeld: last.fxClosing,
    totalPosition: last.closing,
    recognisedRevenue: sum(months.map((m) => m.recognisedRevenue)),
    actualMonths: actualCount,
    actualsThrough: actualCount ? months.filter((m) => m.isActual).at(-1).label : null,
  };

  /* ---- programs departing in the year ---- */

  // By departure date, the same rule the Programs tab uses for its fiscal-year
  // subtotals, so the PDF and the screen agree on which year a program is in.
  const startOf = Object.fromEntries(programs.map((p) => [p.id, p.startDate]));
  const fyOf = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ""))) return null;
    const y = Number(iso.slice(0, 4)); const m = Number(iso.slice(5, 7));
    return m >= 4 ? y : y - 1;
  };
  const progs = (forecast.programs ?? [])
    .map((c) => ({ ...c, startDate: startOf[c.programId] ?? null }))
    .filter((c) => {
      const fy = fyOf(c.startDate);
      if (fy !== null) return fy === startYear;
      // No usable date: fall back to the month its revenue is recognised in.
      return typeof c.recognitionIndex === "number"
        && c.recognitionIndex >= year.startIndex && c.recognitionIndex < year.startIndex + 12;
    })
    .sort((a, b) => String(a.startDate ?? "9999").localeCompare(String(b.startDate ?? "9999"))
      || String(a.name).localeCompare(String(b.name)))
    .map((c) => ({
      name: c.name, season: c.season, startDate: c.startDate, pax: c.pax,
      revenue: c.grossRevenue, cost: c.totalCost, grossProfit: c.contribution,
      gpPct: c.grossRevenue > 0 ? (c.contribution / c.grossRevenue) * 100 : null,
    }));
  const programTotals = progs.reduce((s, p) => ({
    pax: s.pax + (p.pax || 0), revenue: s.revenue + p.revenue,
    cost: s.cost + p.cost, grossProfit: s.grossProfit + p.grossProfit,
  }), { pax: 0, revenue: 0, cost: 0, grossProfit: 0 });

  /* ---- notes ---- */

  const notes = [];
  const emptyFrom = indexOfKey(forecast, forecast.horizon?.emptyFromKey);
  const yearEnd = year.startIndex + 12;

  if (year.noPrograms) {
    notes.push({ level: "warn", text: `No programs are entered for ${year.label}. Every month shows overheads going out and no student money coming in, so the falling balance is the gap in the inputs, not a forecast.` });
  } else if (emptyFrom !== null && emptyFrom < yearEnd) {
    notes.push({ level: "warn", text: `No programs are entered from ${forecast.months[emptyFrom].label} onward. Those months show overheads only, so the balance from there is the gap in the inputs, not a forecast.` });
  }

  if (year.isModelYear) {
    // The engine's warnings are judged on the model's fiscal year, which is
    // this one. The "no programs entered" one is about the runway past it and
    // belongs to whichever later report it falls in.
    for (const w of forecast.warnings ?? []) {
      if (/onward has no programs entered/.test(w)) continue;
      notes.push({ level: "warn", text: w });
    }
  } else {
    // The engine only judges its first year; later years are judged here, on
    // the same rules, so each report carries its own year's warnings.
    if (firstNegative) {
      notes.push({ level: "warn", text: `NZD account goes negative in ${firstNegative.label} — worst ${fmtPlain(lowest.baseClosing)} in ${lowest.label}, after converting everything available.` });
    } else if (firstUnderBuffer) {
      notes.push({ level: "warn", text: `NZD dips below the ${fmtPlain(buffer)} buffer in ${firstUnderBuffer.label}.` });
    }
    if (last.fxClosing > 0.5) {
      notes.push({ level: "info", text: `${fmtPlain(last.fxClosing)} USD is still unconverted at 31 March ${startYear + 1}, valued in the total position at the planning rate.` });
    }
  }

  if (summary.fxConvertedPartial && summary.actualMonths) {
    notes.push({ level: "info", text: "USD converted for the year counts forecast months only. A conversion cannot be told apart from a customer payment in a bank summary, so closed months show n/a." });
  }

  return {
    fiscalYear: {
      startYear,
      label: year.label,
      short: fyShort(startYear),
      range: `1 April ${startYear} – 31 March ${startYear + 1}`,
      isModelYear: year.isModelYear,
      noPrograms: year.noPrograms,
    },
    columns: months.map((m) => ({ key: m.key, label: m.label, isActual: !!m.isActual })),
    rows,
    summary,
    chart: {
      labels: months.map((m) => m.label),
      base: months.map((m) => m.baseClosing),
      total: months.map((m) => m.closing),
      actual: months.map((m) => !!m.isActual),
    },
    programs: progs,
    programTotals,
    notes,
  };
}

function fmtPlain(n) {
  return Math.round(n).toLocaleString("en-NZ");
}

/** "12 October 2026" — for the report header, from a Date. */
export function longDate(d) {
  return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
