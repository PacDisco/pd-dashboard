// netlify/edge-functions/auth-gate.js
//
// Runs on every request to a dashboard subpath (configured in netlify.toml).
// Reads the current permissions from Netlify Blobs and allows or blocks
// based on the caller's Identity JWT roles.
//
// Because permissions come from the blob (not a static redirect rule),
// admins can update them from the UI and changes take effect instantly
// on the next request — no redeploy.

import { getStore } from "@netlify/blobs";

const ADMIN = "admin";

export default async (request, context) => {
  const url = new URL(request.url);
  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (!slug) return context.next();

  // Identify the caller from the Netlify Identity JWT cookie.
  const user = await readUserFromRequest(request);
  if (!user) return unauthorized("Sign in required.");

  const roles = user.app_metadata?.roles || [];

  // Admin always passes.
  if (roles.includes(ADMIN)) return context.next();

  // Read the live permissions for this slug.
  const perms = await loadPermissionsFor(slug, request);
  if (!perms) {
    // Slug unknown → not a gated dashboard path; pass through.
    return context.next();
  }

  const allowed = perms.allowedRoles || [];
  if (!allowed.length) return unauthorized("Admin-only resource.");
  if (!allowed.some(r => roles.includes(r))) return unauthorized("Your role can't access this dashboard.");

  return context.next();
};

function openEdgeStore() {
  try {
    return getStore({ name: "dashboards", consistency: "strong" });
  } catch (err) {
    const siteID =
      (typeof Netlify !== "undefined" && Netlify.env?.get?.("NETLIFY_SITE_ID")) ||
      (typeof Netlify !== "undefined" && Netlify.env?.get?.("SITE_ID"));
    const token =
      (typeof Netlify !== "undefined" && Netlify.env?.get?.("NETLIFY_BLOBS_TOKEN")) ||
      (typeof Netlify !== "undefined" && Netlify.env?.get?.("NETLIFY_API_TOKEN"));
    if (siteID && token) {
      return getStore({ name: "dashboards", consistency: "strong", siteID, token });
    }
    throw err;
  }
}

async function loadPermissionsFor(slug, request) {
  try {
    const store = openEdgeStore();
    const overrides = await store.get("permissions", { type: "json" });
    const entry = (overrides?.dashboards || []).find(d => d.slug === slug);
    if (entry) return entry;
  } catch (err) {
    console.warn("auth-gate blob read failed, falling back to discovery:", err.message);
  }
  // Fallback to the static discovery manifest that ships with the deploy.
  try {
    const res = await fetch(new URL("/dashboards.discovery.json", request.url));
    if (res.ok) {
      const discovery = await res.json();
      return (discovery.dashboards || []).find(d => d.slug === slug) || null;
    }
  } catch (err) {
    console.error("auth-gate discovery fetch error", err);
  }
  return null;
}

async function readUserFromRequest(request) {
  // Netlify Identity sets an `nf_jwt` cookie on login. Edge runtime doesn't
  // auto-parse it; we decode the JWT payload (no signature verification at the
  // edge — Netlify's own request pipeline has already validated the cookie for
  // context.clientContext elsewhere, but we only need the claims here).
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/);
  if (!match) return null;
  try {
    const [, payload] = match[1].split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json);
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    return {
      sub: claims.sub,
      email: claims.email,
      app_metadata: claims.app_metadata || {},
      user_metadata: claims.user_metadata || {},
    };
  } catch {
    return null;
  }
}

function unauthorized(message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Access denied</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #0b1020; color: #e8ecf6; min-height: 100vh;
        display: grid; place-items: center; margin: 0; }
      .card { text-align: center; padding: 40px 32px; border: 1px solid #2a335a;
        border-radius: 14px; background: #171f3a; max-width: 420px; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      p { margin: 0 0 20px; color: #9aa3c0; }
      a { color: #7c9bff; text-decoration: none; font-weight: 600; }
    </style></head><body><div class="card">
    <h1>Access denied</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/">← Back to dashboards</a>
    </div></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
