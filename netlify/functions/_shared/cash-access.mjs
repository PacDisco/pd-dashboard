// netlify/functions/_shared/cash-access.mjs
//
// Role gate for the Cash Forecast endpoints.
//
// WHY READS ARE GATED TOO
// -----------------------
// `/api/*` sits OUTSIDE auth-gate.js (see the warning block in _redirects), so
// nothing checks a role before a request reaches these functions. Everything
// under here is group cash position across all four entities — bank balances,
// receivables, the forecast trough. That is the most sensitive payload on this
// site, more so than the instructor emails that made budget-admin.mjs gate its
// reads. So both reads and writes verify here, using the same GoTrue check.
//
// The dashboard page itself is separately gated by auth-gate.js via
// cash-forecast/dashboard.json. That stops the page rendering for the wrong
// role; THIS is what stops the data being fetched directly.
//
// Roles mirror the existing convention:
//   READ_ROLES   can open the dashboard and see the numbers
//   WRITE_ROLES  can additionally change the assumptions behind them
//
// `admissions`, `outreach`, `flights` and `contractor` are deliberately absent.
// They can sign in to the site; they get a 404 here.

import { verifiedUser } from "./identity.mjs";

export const READ_ROLES = ["admin", "operations"];
export const WRITE_ROLES = ["admin", "operations"];

function has(user, roles) {
  return (user?.roles || []).some((r) => roles.includes(r));
}

/**
 * Verify the caller and check their role.
 *
 * Returns either the user, or a Response to return immediately. Callers must
 * check `instanceof Response` before using the result — the shape makes it
 * awkward to forget, which is the point for an endpoint like this.
 *
 * @param {Request} req
 * @param {'read'|'write'} need
 * @param {string} label  log prefix
 */
export async function requireCashRole(req, need = "read", label = "cash") {
  const user = await verifiedUser(req, label);
  if (!user) return json({ error: "Sign in required." }, 401);

  if (!has(user, READ_ROLES)) {
    // 404 rather than 403 on purpose. Someone in `admissions` poking at the
    // dashboard's endpoints should not learn that a group cash flow API exists
    // here. They can't reach the data either way; this just doesn't advertise it.
    return json({ error: "Not found" }, 404);
  }

  if (need === "write" && !has(user, WRITE_ROLES)) {
    return json({ error: "Your role can view cash flow but not change it." }, 403);
  }

  return user;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function canEdit(user) {
  return has(user, WRITE_ROLES);
}

export default { requireCashRole, canEdit, json, READ_ROLES, WRITE_ROLES };
