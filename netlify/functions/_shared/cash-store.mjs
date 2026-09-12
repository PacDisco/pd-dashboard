// netlify/functions/_shared/cash-store.mjs
//
// Assumptions storage for the Cash Forecast dashboard.
//
// WHY BLOBS RATHER THAN NEON
// --------------------------
// Every other stateful surface here (field budget, instructors, time tracking)
// uses Postgres, because those are relational — many rows, queried and filtered.
// This is the opposite shape: one JSON document per fiscal year, always read and
// written whole, never queried by field. Modelling programs, payment rules,
// booking curves and twelve months of overheads as tables would mean five joins
// to reconstruct a document nothing ever queries into. Blobs is already a
// dependency (auth-gate.js reads dashboard permissions from it) and is the
// closer fit. If this ever needs per-field history or cross-year reporting,
// that's the point to move it.
//
// Every save also writes a timestamped copy. Assumptions ARE the model now —
// if someone changes a pax number and November moves by 300k, you want to see
// who changed what and roll back. That's what the versioned-filename workbook
// ("...v5 - 31 August 2026.xlsx") never actually gave anyone.

import { getStore } from "@netlify/blobs";
import { defaultAssumptions } from "../../../cash-forecast/model.mjs";

const STORE = "cash-assumptions";

function store() {
  return getStore({ name: STORE, consistency: "strong" });
}

function currentKey(fiscalYearStartYear) {
  return `current/${fiscalYearStartYear}`;
}

/** Fiscal year starting April. Before April we're still in last year's. */
export function currentFiscalYear(now = new Date()) {
  return now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export async function loadAssumptions(fiscalYearStartYear) {
  const saved = await store().get(currentKey(fiscalYearStartYear), { type: "json" });
  return saved ?? defaultAssumptions(fiscalYearStartYear);
}

export async function saveAssumptions(assumptions, editedBy) {
  const next = {
    ...assumptions,
    updatedAt: new Date().toISOString(),
    updatedBy: editedBy,
  };
  const s = store();
  await s.setJSON(currentKey(next.fiscalYearStartYear), next);
  await s.setJSON(`history/${next.fiscalYearStartYear}/${next.updatedAt}`, next);
  return next;
}

export async function listVersions(fiscalYearStartYear) {
  const { blobs } = await store().list({ prefix: `history/${fiscalYearStartYear}/` });
  return blobs
    .map((b) => ({ at: b.key.split("/").pop() }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 50);
}

export async function loadVersion(fiscalYearStartYear, at) {
  return store().get(`history/${fiscalYearStartYear}/${at}`, { type: "json" });
}

/**
 * Decide the 1 April opening balances the forecast should actually run from.
 *
 * The year's opening flows through all twelve months untouched, so a wrong
 * NZD/USD split converts at the wrong times for the whole year — which is why
 * this is worth taking from the bank rather than from a number typed once.
 *
 * April's `opening` is the balance at the FIRST of the month, so unlike a
 * closing balance it is trustworthy even while April is still in progress.
 *
 * Falls back per currency, not wholesale: if Xero has no account in a currency,
 * that currency keeps its typed figure. Zeroing a real USD balance because no
 * USD account was found in Xero would be a silent, expensive lie.
 *
 * Pure — no I/O, so it is testable without Blobs or Xero.
 *
 * @param {object} assumptions
 * @param {object|null} aprilRecord  the stored `{fy}-04` month, or null
 * @returns {{balances: object, source: string, fromXero: object, typed: object, mixed: boolean}}
 */
export function resolveOpeningBalances(assumptions, aprilRecord) {
  const typed = { ...(assumptions.openingBalances ?? {}) };
  const want = assumptions.openingBalanceSource ?? "xero";

  const byCurrency = aprilRecord?.byCurrency ?? null;
  if (want !== "xero" || !byCurrency) {
    return {
      balances: typed,
      source: want === "xero" ? "manual-no-data" : "manual",
      fromXero: null,
      typed,
      mixed: false,
    };
  }

  const fromXero = {};
  const balances = { ...typed };
  let usedXero = 0;
  let usedTyped = 0;

  for (const cur of Object.keys(typed)) {
    const opening = byCurrency[cur]?.opening;
    if (Number.isFinite(opening)) {
      fromXero[cur] = opening;
      balances[cur] = opening;
      usedXero++;
    } else {
      usedTyped++;
    }
  }
  // A currency Xero knows about that the model does not is worth surfacing —
  // it usually means a real account nobody put in the model.
  for (const [cur, v] of Object.entries(byCurrency)) {
    if (!(cur in balances) && Number.isFinite(v?.opening)) {
      fromXero[cur] = v.opening;
      balances[cur] = v.opening;
      usedXero++;
    }
  }

  return {
    balances,
    source: usedXero === 0 ? "manual-no-data" : "xero",
    fromXero: usedXero ? fromXero : null,
    typed,
    mixed: usedXero > 0 && usedTyped > 0,
  };
}

/**
 * Decide the twelve monthly overhead figures the forecast should run on.
 *
 * Three sources, in priority order, per month:
 *
 *   actual   a month that has been closed off, taken from the P&L. What was
 *            really spent, non-cash lines removed.
 *   budget   any other month, from Xero's Budget Manager. What is planned.
 *   typed    neither of the above — the figure someone entered by hand.
 *
 * That ordering is the point of the whole thing: the past comes from the books,
 * the future comes from the budget, and twelve numbers copied out of a workbook
 * once a year stop being load-bearing.
 *
 * EVERY MONTH REPORTS ITS SOURCE. A figure that silently changed where it came
 * from is worse than a wrong one, because nobody can tell which is which. The
 * UI labels each month from `sources`.
 *
 * Pure — no I/O, so it is testable without Blobs or Xero.
 *
 * @param {object} assumptions
 * @param {{opexByMonth?: object, budgetMonths?: number[]|null}} xero
 * @returns {{months: number[], sources: string[], counts: object}}
 */
export function resolveMonthlyOverheads(assumptions, xero = {}) {
  const typed = Array.isArray(assumptions.monthlyOverheads)
    ? assumptions.monthlyOverheads.map((n) => Number(n) || 0)
    : Array(12).fill(0);

  // "manual" pins the typed figures outright, for a year someone wants frozen.
  if ((assumptions.overheadSource ?? "auto") !== "auto") {
    return { months: typed, sources: Array(12).fill("typed"), counts: { typed: 12 } };
  }

  const fy = assumptions.fiscalYearStartYear;
  const through = assumptions.actualsThroughMonth || null;
  const opex = xero.opexByMonth ?? {};
  const budget = Array.isArray(xero.budgetMonths) ? xero.budgetMonths : null;

  const months = [];
  const sources = [];
  for (let slot = 0; slot < 12; slot++) {
    const abs = 3 + slot;
    const key = `${fy + Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
    const closed = Boolean(through) && key <= through;
    const actual = opex[key];

    // A closed month with a real figure wins. `cashTotal` can legitimately be
    // zero, so presence is tested rather than truthiness — a genuinely zero
    // month must not fall through to the budget and look like a forecast.
    if (closed && actual && Number.isFinite(actual.cashTotal)) {
      months.push(actual.cashTotal);
      sources.push("actual");
      continue;
    }
    if (budget && Number.isFinite(budget[slot]) && budget[slot] !== 0) {
      months.push(budget[slot]);
      sources.push("budget");
      continue;
    }
    months.push(typed[slot]);
    sources.push("typed");
  }

  const counts = sources.reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {});
  return { months, sources, counts };
}

/**
 * Reject anything that would corrupt the model before it reaches storage.
 *
 * The UI validates too, but the UI is not the only thing that can POST here —
 * and a bad write lands in the blob that every subsequent read trusts.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateAssumptions(input) {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Body must be an object" };
  }

  const fy = Number(input.fiscalYearStartYear);
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
    return { ok: false, error: "fiscalYearStartYear must be a sensible year" };
  }

  if (!Array.isArray(input.programs)) {
    return { ok: false, error: "programs must be an array" };
  }
  const seenIds = new Set();
  for (const p of input.programs) {
    if (!p || !p.id || !p.name) {
      return { ok: false, error: "every program needs an id and a name" };
    }
    if (seenIds.has(p.id)) {
      return { ok: false, error: `duplicate program id "${p.id}"` };
    }
    seenIds.add(p.id);

    for (const field of ["price", "fixedCost", "variableCostPerPax", "paxForecast"]) {
      const v = Number(p[field]);
      if (!Number.isFinite(v) || v < 0) {
        return { ok: false, error: `${p.name}: ${field} must be a number of at least 0` };
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate ?? "")) {
      return { ok: false, error: `${p.name}: startDate must be yyyy-mm-dd` };
    }
    if (!["Fall", "Spring", "Summer"].includes(p.season)) {
      return { ok: false, error: `${p.name}: season must be Fall, Spring or Summer` };
    }
  }

  for (const field of ["monthlyOverheads", "monthlyCapital", "monthlyTax"]) {
    const arr = input[field];
    if (!Array.isArray(arr) || arr.length !== 12 || arr.some((n) => !Number.isFinite(Number(n)))) {
      return { ok: false, error: `${field} must be 12 numbers, April first` };
    }
  }

  if (typeof input.fxRates !== "object" || input.fxRates === null) {
    return { ok: false, error: "fxRates must be an object" };
  }
  if (!Number.isFinite(Number(input.fxRates.NZD))) {
    return { ok: false, error: "fxRates must include a rate for NZD" };
  }

  if (typeof input.openingBalances !== "object" || input.openingBalances === null) {
    return { ok: false, error: "openingBalances must be an object keyed by currency" };
  }
  for (const [cur, v] of Object.entries(input.openingBalances)) {
    if (!Number.isFinite(Number(v))) {
      return { ok: false, error: `opening balance for ${cur} must be a number` };
    }
  }

  if (!Number.isFinite(Number(input.baseMinimumBuffer)) || Number(input.baseMinimumBuffer) < 0) {
    return { ok: false, error: "baseMinimumBuffer must be a number of at least 0" };
  }

  if (input.actualsThroughMonth != null && !/^\d{4}-\d{2}$/.test(input.actualsThroughMonth)) {
    return { ok: false, error: "actualsThroughMonth must be YYYY-MM or null" };
  }

  if (input.overheadSource != null && !["auto", "manual"].includes(input.overheadSource)) {
    return { ok: false, error: "overheadSource must be auto or manual" };
  }
  if (input.xeroBudgetId != null && typeof input.xeroBudgetId !== "string") {
    return { ok: false, error: "xeroBudgetId must be a string" };
  }

  const nzdShare = input.defaultPaymentRules?.nzdReceiptShare;
  if (nzdShare != null && (!Number.isFinite(Number(nzdShare)) || Number(nzdShare) < 0 || Number(nzdShare) > 1)) {
    return { ok: false, error: "nzdReceiptShare must be a share between 0 and 1" };
  }

  // Curves decide WHICH MONTH money lands in, which is the whole output of a
  // cash forecast. A malformed one silently moves millions between months.
  for (const which of ["bookingCurve", "balanceCurve", "receiptsCurve"]) {
    const curve = input.defaultPaymentRules?.[which];
    if (curve == null) continue;
    if (!Array.isArray(curve) || curve.length === 0) {
      return { ok: false, error: `${which} must be a non-empty array` };
    }
    for (const p of curve) {
      if (!Number.isFinite(Number(p?.monthsBefore)) || Number(p.monthsBefore) < 0 || Number(p.monthsBefore) > 36) {
        return { ok: false, error: `${which}: monthsBefore must be between 0 and 36` };
      }
      if (!Number.isFinite(Number(p?.share)) || Number(p.share) < 0) {
        return { ok: false, error: `${which}: every share must be a number of at least 0` };
      }
    }
    if (curve.reduce((s, p) => s + Number(p.share), 0) <= 0) {
      return { ok: false, error: `${which}: shares cannot all be zero` };
    }
  }

  // A wrong recognition month can move an entire season's revenue out of the
  // fiscal year, so this is checked rather than trusted.
  if (input.recognitionMonths != null) {
    if (typeof input.recognitionMonths !== "object") {
      return { ok: false, error: "recognitionMonths must be an object keyed by season" };
    }
    for (const [season, month] of Object.entries(input.recognitionMonths)) {
      const m = Number(month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return { ok: false, error: `recognition month for ${season} must be a month number 1-12` };
      }
    }
    for (const season of ["Fall", "Spring", "Summer"]) {
      if (input.recognitionMonths[season] == null) {
        return { ok: false, error: `recognitionMonths is missing ${season}` };
      }
    }
  }

  if (input.openingBalanceSource != null
      && !["xero", "manual"].includes(input.openingBalanceSource)) {
    return { ok: false, error: "openingBalanceSource must be xero or manual" };
  }

  const sources = ["manual", "avg30", "avg60", "avg90", "current"];
  if (input.planningRateSource && !sources.includes(input.planningRateSource)) {
    return { ok: false, error: `planningRateSource must be one of ${sources.join(", ")}` };
  }

  return { ok: true, value: input };
}

export default { loadAssumptions, saveAssumptions, validateAssumptions, currentFiscalYear };
