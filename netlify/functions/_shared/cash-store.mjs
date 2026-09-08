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

  const sources = ["manual", "avg30", "avg60", "avg90", "current"];
  if (input.planningRateSource && !sources.includes(input.planningRateSource)) {
    return { ok: false, error: `planningRateSource must be one of ${sources.join(", ")}` };
  }

  return { ok: true, value: input };
}

export default { loadAssumptions, saveAssumptions, validateAssumptions, currentFiscalYear };
