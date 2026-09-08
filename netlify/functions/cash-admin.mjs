// netlify/functions/cash-admin.mjs
//
// Writes for the Cash Forecast dashboard. Split from cash-forecast.mjs so the
// read path stays a plain GET and this one is unambiguously the surface that
// changes things — the same split budget-admin.mjs makes.
//
// Routes (POST, JSON body with { action }):
//   save     { assumptions }              -> replace the assumptions for its year
//   restore  { fiscalYearStartYear, at }  -> roll back to a saved version
//
// Every save writes a timestamped copy alongside the current one, so a bad
// change is recoverable without anyone hunting for the last emailed workbook.

import { requireCashRole, json } from "./_shared/cash-access.mjs";
import {
  loadVersion,
  saveAssumptions,
  validateAssumptions,
} from "./_shared/cash-store.mjs";

export default async (req) => {
  const user = await requireCashRole(req, "write", "cash-admin");
  if (user instanceof Response) return user;

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = body?.action;

  if (action === "save") {
    const checked = validateAssumptions(body.assumptions);
    if (!checked.ok) return json({ error: checked.error }, 400);

    const saved = await saveAssumptions(checked.value, user.email || "unknown");
    return json({ assumptions: saved });
  }

  if (action === "restore") {
    const fy = Number(body.fiscalYearStartYear);
    const at = String(body.at || "");
    if (!Number.isInteger(fy) || !at) {
      return json({ error: "restore needs fiscalYearStartYear and at" }, 400);
    }

    const version = await loadVersion(fy, at);
    if (!version) return json({ error: "That version no longer exists" }, 404);

    // Re-validate on the way back in. A version written by an older shape of
    // the model should not be able to skip the checks just because it was
    // stored once already.
    const checked = validateAssumptions(version);
    if (!checked.ok) {
      return json({ error: `That version is no longer valid: ${checked.error}` }, 409);
    }

    const saved = await saveAssumptions(checked.value, user.email || "unknown");
    return json({ assumptions: saved, restoredFrom: at });
  }

  return json({ error: `Unknown action "${action}"` }, 400);
};
