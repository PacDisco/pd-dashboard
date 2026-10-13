// netlify/functions/_shared/popups-access.mjs
//
// Who may use the popup designer API (/api/popups). /api/* is outside
// auth-gate.js, so every request is verified here with the same rule that
// decides who can open /popups/ (dashboard grants, or the dashboard's
// allowedRoles when nobody has been granted anything yet).

import { getStore } from "@netlify/blobs";
import { verifiedUser, actorName } from "./identity.mjs";
import { canAccess, normalizeGrants } from "../../edge-functions/lib/dashboard-access.js";

export const DASHBOARD_SLUG = "popups";
// Keep in step with popups/dashboard.json → allowedRoles.
export const DEFAULT_ALLOWED_ROLES = ["admin", "outreach", "admissions"];

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function accessInputs() {
  let grants = null;
  let dashboard = { slug: DASHBOARD_SLUG, allowedRoles: DEFAULT_ALLOWED_ROLES };
  let s = null;
  try { s = getStore({ name: "dashboards", consistency: "strong" }); } catch { s = null; }
  if (s) {
    try {
      const raw = await s.get("grants", { type: "json" });
      grants = raw ? normalizeGrants(raw) : null;
    } catch (e) {
      // A failed read must not widen access: null = the role rule, which is stricter.
      console.warn("[popups] grants read failed:", e.message);
    }
    try {
      const perms = await s.get("permissions", { type: "json" });
      const entry = (perms?.dashboards || []).find((d) => d.slug === DASHBOARD_SLUG);
      if (entry) dashboard = entry;
    } catch { /* defaults */ }
  }
  return { grants, dashboard };
}

/** @returns {Promise<Response | {email:string,name:string,roles:string[],actor:string}>} */
export async function requirePopupEditor(req, deps = {}) {
  const verify = deps.verifiedUser || verifiedUser;
  const user = await verify(req, "popups");
  if (!user) return json({ error: "Sign in required." }, 401);
  const { grants, dashboard } = deps.accessInputs ? await deps.accessInputs() : await accessInputs();
  if (!canAccess({ email: user.email, roles: user.roles, slug: DASHBOARD_SLUG, dashboard, grants })) {
    return json({ error: "You don't have access to Website Popups." }, 403);
  }
  return { ...user, actor: actorName(user) };
}
