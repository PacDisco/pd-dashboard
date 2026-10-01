// netlify/functions/_shared/program-pages-access.mjs
//
// Who may use the Program Pages endpoints.
//
// /api/* is outside auth-gate.js, so the dashboard page being gated does NOT
// protect these functions. Every request is verified here instead:
//
//   EDIT     = the same rule that decides who can open /program-pages/ —
//              admin, or the person's dashboard grants, or (no grants record
//              yet) the dashboard's allowedRoles. One rule, imported from
//              edge-functions/lib/dashboard-access.js, so the page and the
//              API can't disagree about who is an editor.
//   PUBLISH  = EDIT plus a publishing role. Anyone with access can draft;
//              only these roles can put a change live. Override with
//              PROGRAM_PAGES_PUBLISH_ROLES="admin,outreach,programs".
//
// The build token (PROGRAM_PAGES_BUILD_TOKEN) is a separate, read-only path
// used by the public pd-program-pages build. See tokenOk().

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { verifiedUser, actorName } from "./identity.mjs";
import { canAccess, normalizeGrants, isAdmin } from "../../edge-functions/lib/dashboard-access.js";

export const DASHBOARD_SLUG = "program-pages";
// Keep in step with program-pages/dashboard.json → allowedRoles.
export const DEFAULT_ALLOWED_ROLES = ["admin", "outreach", "programs", "admissions"];

export function publishRoles() {
  const raw = process.env.PROGRAM_PAGES_PUBLISH_ROLES || "admin,outreach,programs";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
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
      // A failed read must not widen access: null = legacy role rule, which is stricter.
      console.warn("[program-pages] grants read failed:", e.message);
    }
    try {
      const perms = await s.get("permissions", { type: "json" });
      const entry = (perms?.dashboards || []).find((d) => d.slug === DASHBOARD_SLUG);
      if (entry) dashboard = entry;
    } catch { /* fall back to defaults */ }
  }
  return { grants, dashboard };
}

/**
 * @returns {Promise<Response | {email:string,name:string,roles:string[],actor:string,canPublish:boolean}>}
 */
export async function requireEditor(req, label = "program-pages", deps = {}) {
  const verify = deps.verifiedUser || verifiedUser;
  const user = await verify(req, label);
  if (!user) return json({ error: "Sign in required." }, 401);
  const { grants, dashboard } = deps.accessInputs ? await deps.accessInputs() : await accessInputs();
  const ok = canAccess({ email: user.email, roles: user.roles, slug: DASHBOARD_SLUG, dashboard, grants });
  if (!ok) return json({ error: "You don't have access to Program Pages." }, 403);
  const pubRoles = publishRoles();
  return {
    ...user,
    actor: actorName(user),
    canPublish: isAdmin(user.roles) || (user.roles || []).some((r) => pubRoles.includes(r)),
  };
}

/** Constant-time check of `Authorization: Bearer <PROGRAM_PAGES_BUILD_TOKEN>`. */
export function tokenOk(req) {
  const expected = process.env.PROGRAM_PAGES_BUILD_TOKEN || "";
  if (expected.length < 24) return false; // unset or too weak → the token path is closed
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim());
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
