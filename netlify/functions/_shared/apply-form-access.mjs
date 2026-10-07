// netlify/functions/_shared/apply-form-access.mjs
//
// Who may use /api/apply-forms. Same rule as the dashboard page itself (admin,
// the person's dashboard grants, or — with no grants record — allowedRoles),
// imported from edge-functions/lib/dashboard-access.js so the page and the API
// can't disagree. /api/* is outside auth-gate.js, so this check is the gate.
//
//   EDIT     anyone with access to the Apply Form dashboard
//   PUBLISH  EDIT + a publishing role (APPLY_FORM_PUBLISH_ROLES,
//            default "admin,admissions,outreach")

import { getStore } from "@netlify/blobs";
import { verifiedUser, actorName } from "./identity.mjs";
import { canAccess, normalizeGrants, isAdmin } from "../../edge-functions/lib/dashboard-access.js";

export const DASHBOARD_SLUG = "apply-form";
// Keep in step with apply-form/dashboard.json → allowedRoles.
export const DEFAULT_ALLOWED_ROLES = ["admin", "admissions", "outreach"];

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function publishRoles() {
  return (process.env.APPLY_FORM_PUBLISH_ROLES || "admin,admissions,outreach")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

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
      console.warn("[apply-form] grants read failed:", e.message); // null = stricter legacy rule
    }
    try {
      const perms = await s.get("permissions", { type: "json" });
      const entry = (perms?.dashboards || []).find((d) => d.slug === DASHBOARD_SLUG);
      if (entry) dashboard = entry;
    } catch { /* defaults */ }
  }
  return { grants, dashboard };
}

/** @returns {Promise<Response | {email,name,roles,actor,canPublish}>} */
export async function requireEditor(req, deps = {}) {
  const verify = deps.verifiedUser || verifiedUser;
  const user = await verify(req, "apply-forms");
  if (!user) return json({ error: "Sign in required." }, 401);
  const { grants, dashboard } = deps.accessInputs ? await deps.accessInputs() : await accessInputs();
  if (!canAccess({ email: user.email, roles: user.roles, slug: DASHBOARD_SLUG, dashboard, grants })) {
    return json({ error: "You don't have access to the Apply Form dashboard." }, 403);
  }
  const roles = publishRoles();
  return { ...user, actor: actorName(user), canPublish: isAdmin(user.roles) || (user.roles || []).some((r) => roles.includes(r)) };
}
