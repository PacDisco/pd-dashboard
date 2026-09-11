// netlify/functions/_shared/cash-phasing.mjs
//
// Derive supplier cost phasing from what actually happened.
//
// WHY
// ---
// The model spreads a program's cost 25% the month before departure, 45% in the
// departure month, 25% after and 5% the month after that. That curve was
// invented. Pacific Discovery's own P&L for Apr-Aug 2026 shows 316,915 of
// program cost already incurred for a season departing 1 September — while the
// model says zero until August. Supplier deposits and flights are paid months
// ahead, and the July trough moves with every one of them.
//
// So: stop inventing a curve. Read per-program cost by month from the tracked
// P&L, line each program up against its own departure date, and let the shape
// fall out of the data.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does not silently replace the curve. A derived curve built on two months of
// one season is worse than an honest guess, because it looks authoritative. The
// derivation reports its own coverage — how many programs, how many months, how
// much of each program's total cost is actually accounted for — and the caller
// decides whether that is enough to adopt.
//
// Accrual, not cash: the tracked P&L books a supplier invoice when it is raised,
// not when it is paid. For a business paying suppliers on short terms the two
// are close; where they are not, this curve runs slightly early.

/** Months between a program's departure and a given "YYYY-MM", signed. */
export function monthOffset(departureISO, key) {
  const [dy, dm] = departureISO.split("-").map(Number);
  const [ky, km] = key.split("-").map(Number);
  return (ky * 12 + km) - (dy * 12 + dm);
}

/**
 * Build an offset curve from observed per-program monthly costs.
 *
 * @param {Array<{programId, departure, byMonth: Record<string, number>, totalCost?: number}>} observations
 * @param {{minPrograms?: number, minCoverage?: number}} opts
 * @returns {{offsets, coverage, programs, observedMonths, adoptable, reasons}}
 */
export function derivePhasing(observations, opts = {}) {
  const minPrograms = opts.minPrograms ?? 2;
  const minCoverage = opts.minCoverage ?? 0.6;

  const byOffset = new Map();
  const perProgram = [];
  const allMonths = new Set();
  let grandTotal = 0;

  for (const obs of observations) {
    if (!obs?.departure || !obs?.byMonth) continue;
    const entries = Object.entries(obs.byMonth).filter(([, v]) => Number.isFinite(v) && v !== 0);
    const observed = entries.reduce((s, [, v]) => s + v, 0);
    if (observed <= 0) continue;

    for (const [key, amount] of entries) {
      allMonths.add(key);
      const off = monthOffset(obs.departure, key);
      byOffset.set(off, (byOffset.get(off) || 0) + amount);
    }
    grandTotal += observed;

    // Coverage per program: how much of its expected total cost has actually
    // been seen. A program observed for two of its six spending months produces
    // a curve shape that is real but incomplete, and that has to be visible.
    const expected = Number(obs.totalCost) || 0;
    perProgram.push({
      programId: obs.programId,
      departure: obs.departure,
      observed: Math.round(observed),
      expected: Math.round(expected),
      coverage: expected > 0 ? observed / expected : null,
      months: entries.length,
    });
  }

  const offsets = [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([monthOffset, amount]) => ({
      monthOffset,
      share: grandTotal > 0 ? amount / grandTotal : 0,
      amount: Math.round(amount),
    }));

  const withExpected = perProgram.filter((p) => p.coverage !== null);
  const coverage = withExpected.length
    ? withExpected.reduce((s, p) => s + p.coverage, 0) / withExpected.length
    : null;

  // Whether this is fit to adopt, and if not, why — so the answer is never a
  // bare "no".
  const reasons = [];
  if (perProgram.length < minPrograms) {
    reasons.push(`only ${perProgram.length} program(s) had any cost recorded — need at least ${minPrograms}`);
  }
  if (coverage !== null && coverage < minCoverage) {
    reasons.push(`only ${Math.round(coverage * 100)}% of expected program cost has been incurred so far — the tail of the curve has not happened yet`);
  }
  if (coverage === null) {
    reasons.push("no expected total cost to compare against, so completeness is unknown");
  }
  // A curve that is all in the past relative to departure means no program in
  // the sample has departed yet, so the post-departure tail is pure absence.
  if (offsets.length && offsets.every((o) => o.monthOffset < 0)) {
    reasons.push("every observation is before departure — nothing after a departure has been seen yet");
  }

  return {
    offsets,
    coverage,
    programs: perProgram,
    observedMonths: [...allMonths].sort(),
    totalObserved: Math.round(grandTotal),
    adoptable: reasons.length === 0,
    reasons,
  };
}

/**
 * Compare a derived curve against the one in use, in the terms that matter:
 * how much of the spend each puts before departure.
 */
export function comparePhasing(derived, current) {
  const before = (offsets) => offsets
    .filter((o) => o.monthOffset < 0)
    .reduce((s, o) => s + o.share, 0);

  return {
    currentShareBeforeDeparture: Number(before(current ?? []).toFixed(4)),
    derivedShareBeforeDeparture: Number(before(derived ?? []).toFixed(4)),
    currentEarliestMonth: Math.min(...(current ?? [{ monthOffset: 0 }]).map((o) => o.monthOffset)),
    derivedEarliestMonth: derived?.length ? Math.min(...derived.map((o) => o.monthOffset)) : null,
  };
}

export default { derivePhasing, comparePhasing, monthOffset };
