// netlify/functions/_shared/checkins-access.mjs
//
// Who may manage instructor check-ins (/api/checkins/admin, /oauth/start).
//
// /api/* is outside auth-gate.js, so the /instructor-checkins/ page being gated
// does NOT protect these functions. Same rule as the page, imported from
// edge-functions/lib/dashboard-access.js so the page and API can't disagree:
// admin, or the person's dashboard grants, or (no grants record yet) the
// dashboard's allowedRoles.

import { getStore } from "@netlify/blobs";
import { verifiedUser, actorName } from "./identity.mjs";
import { canAccess, normalizeGrants } from "../../edge-functions/lib/dashboard-access.js";
import { json } from "./checkins.mjs";

export const DASHBOARD_SLUG = "instructor-checkins";
// Keep in step with instructor-checkins/dashboard.json → allowedRoles.
export const DEFAULT_ALLOWED_ROLES = ["admin", "programs", "operations"];

function store() {
  try {
    return getStore({ name: "dashboards", consistency: "strong" });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    return siteID && token ? getStore({ name: "dashboards", consistency: "strong", siteID, token }) : null;
  }
}

async function accessInputs() {
  const s = store();
  let grants = null;
  let dashboard = { slug: DASHBOARD_SLUG, allowedRoles: DEFAULT_ALLOWED_ROLES };
  if (s) {
    try {
      const raw = await s.get("grants", { type: "json" });
      grants = raw ? normalizeGrants(raw) : null;
    } catch (e) {
      // A failed read must not widen access: null = legacy role rule, which is stricter.
      console.warn("[checkins] grants read failed:", e.message);
    }
    try {
      const perms = await s.get("permissions", { type: "json" });
      const entry = (perms?.dashboards || []).find((d) => d.slug === DASHBOARD_SLUG);
      if (entry) dashboard = entry;
    } catch { /* defaults */ }
  }
  return { grants, dashboard };
}

/** @returns {Promise<Response | {email,name,roles,actor}>} */
export async function requireManager(req, label = "checkins", deps = {}) {
  const verify = deps.verifiedUser || verifiedUser;
  const user = await verify(req, label);
  if (!user) return json({ error: "Sign in required." }, 401);
  const { grants, dashboard } = deps.accessInputs ? await deps.accessInputs() : await accessInputs();
  const ok = canAccess({ email: user.email, roles: user.roles, slug: DASHBOARD_SLUG, dashboard, grants });
  if (!ok) return json({ error: "You don't have access to Instructor Check-ins." }, 403);
  return { ...user, actor: actorName(user) };
}
