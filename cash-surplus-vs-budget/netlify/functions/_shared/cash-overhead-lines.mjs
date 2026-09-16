// netlify/functions/_shared/cash-overhead-lines.mjs
//
// What the overheads are actually made of.
//
// WHY THIS EXISTS
// ---------------
// The dashboard could say August's overheads were 82,369 and nothing about what
// the 82,369 was. "Reduce overheads" was therefore a number to type rather than
// a list to argue with. Every closed month's P&L fetch has stored the expense
// lines all along; nothing read them.
//
// THE TRAP THIS MODULE IS MOSTLY ABOUT
// ------------------------------------
// The obvious aggregation — group by name, sum, divide by the number of months
// the name appeared in — is wrong, and wrong in the direction that matters.
//
// A line absent from a month's P&L means the organisation spent nothing on it
// that month. It does NOT mean the month has no opinion. Dividing a line's
// total by "months it appeared in" gives the average of the months it was
// spent, which for anything seasonal is far above the monthly run rate, and
// makes a genuinely lumpy cost look like a large steady one. That is precisely
// backwards for deciding what to cut: a large steady line is a standing
// commitment worth renegotiating, a lumpy one is a series of decisions.
//
// So the denominator here is always the number of months OBSERVED, and an
// absent line contributes a real zero.
//
// Pure — no I/O — so it runs against fixtures.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * One line's shape across the observed months.
 *
 * `spread` is the largest single month divided by the mean. A steady line sits
 * near 1; a line that lands once a year across twelve months sits near 12. It
 * answers "is this a standing cost or an event" without needing a threshold
 * argued in advance — though one is offered below for the page's convenience.
 */
function describe(amounts, monthsObserved) {
  const total = amounts.reduce((s, v) => s + v, 0);
  // ALWAYS over every observed month, never over the months this line appeared
  // in. See the header — this is the whole point of the module.
  const mean = monthsObserved > 0 ? total / monthsObserved : 0;
  const nonZero = amounts.filter((v) => Math.abs(v) > 0.5).length;
  const peak = amounts.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
  const spread = Math.abs(mean) > 0.5 ? Math.abs(peak) / Math.abs(mean) : 0;
  return { total, mean, nonZero, peak, spread };
}

/**
 * Aggregate stored opex months into a per-line view.
 *
 * @param months  stored opex records, each { month, lines: [{name, amount, nonCash}] }
 *                Records from before parser version 5 carry `topLines` only;
 *                those are used, and reported as truncated, rather than being
 *                silently averaged as if they were complete.
 * @param opts.basis  "cash" excludes non-cash lines (revaluations, unrealised
 *                FX); "total" keeps them. Defaults to cash, because the whole
 *                context here is a cash forecast.
 */
export function overheadLines(months = [], { basis = "cash", steadyBelow = 2 } = {}) {
  const observed = months
    .filter((m) => m && (Array.isArray(m.lines) || Array.isArray(m.topLines)))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));

  const monthKeys = observed.map((m) => m.month);
  // A record stored before every line was kept. Its absent lines are genuinely
  // unknown rather than zero, which changes what an average means — so this is
  // surfaced rather than folded in.
  const truncatedMonths = observed.filter((m) => !Array.isArray(m.lines)).map((m) => m.month);

  const byName = new Map();
  observed.forEach((m, i) => {
    const source = Array.isArray(m.lines) ? m.lines : m.topLines;
    for (const line of source) {
      const name = String(line?.name ?? "").trim();
      if (!name) continue;
      if (basis === "cash" && line.nonCash) continue;
      if (!byName.has(name)) {
        byName.set(name, { name, amounts: Array(observed.length).fill(0), nonCash: Boolean(line.nonCash) });
      }
      // += rather than =, because a P&L can carry the same account name twice
      // under different parents and a walk collects both leaves.
      byName.get(name).amounts[i] += num(line.amount);
    }
  });

  const lines = [...byName.values()]
    .map((l) => ({ ...l, ...describe(l.amounts, observed.length) }))
    .map((l) => ({
      name: l.name,
      nonCash: l.nonCash,
      total: Math.round(l.total),
      monthlyMean: Math.round(l.mean),
      // Twelve times the monthly mean. Stated explicitly because it is the
      // figure a decision gets made against — "this costs 21,600 a year" is
      // actionable in a way "1,800 in June" is not — and because deriving it
      // from a mean over the wrong denominator is the error above, made
      // visible.
      annualised: Math.round(l.mean * 12),
      monthsWithSpend: l.nonZero,
      peak: Math.round(l.peak),
      spread: Math.round(l.spread * 100) / 100,
      steady: l.nonZero >= Math.max(2, Math.ceil(observed.length * 0.6)) && l.spread <= steadyBelow,
      amounts: l.amounts.map((v) => Math.round(v)),
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  const total = lines.reduce((s, l) => s + l.total, 0);
  const steadyTotal = lines.filter((l) => l.steady).reduce((s, l) => s + l.total, 0);

  return {
    basis,
    monthKeys,
    monthsObserved: observed.length,
    truncatedMonths,
    total,
    monthlyMean: observed.length ? Math.round(total / observed.length) : 0,
    annualised: observed.length ? Math.round((total / observed.length) * 12) : 0,
    lines,
    // The split that decides how you go about it. Steady cost is renegotiated —
    // a contract, a subscription, a headcount. Lumpy cost is a set of separate
    // decisions and is cut one at a time.
    steadyTotal,
    lumpyTotal: total - steadyTotal,
    steadySharePct: total > 0 ? Math.round((steadyTotal / total) * 1000) / 10 : 0,
    // The smallest number of lines that together make up 80% of the spend.
    // Cutting overheads is nearly always a conversation about a handful of
    // lines, and this says how many that handful is before anyone reads a list
    // of forty.
    concentration: concentration(lines, total),
  };
}

function concentration(lines, total, share = 0.8) {
  if (total <= 0) return { lines: 0, sharePct: 0, names: [] };
  let running = 0;
  const names = [];
  for (const l of lines) {
    if (l.total <= 0) break;
    running += l.total;
    names.push(l.name);
    if (running / total >= share) break;
  }
  return {
    lines: names.length,
    sharePct: Math.round((running / total) * 1000) / 10,
    names,
  };
}

export default { overheadLines };
