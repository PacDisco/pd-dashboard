// netlify/functions/config.js
//
// GET  /api/config        → returns merged dashboard manifest (discovery + permissions)
//                           requires any authenticated Identity user
// PUT  /api/config        → replaces the permissions overrides in Netlify Blobs
//                           requires the caller to have the "admin" role
//
// Discovery manifest is loaded via HTTP from the site itself
// (avoids all bundler/filesystem issues). Permissions live in a Netlify Blob.

import { getStore } from "@netlify/blobs";
import fs from "node:fs/promises";
import path from "node:path";

const BLOB_KEY = "permissions";
const STORE = "dashboards";

// Netlify normally auto-binds the blob context; if that fails (e.g. the
// package was marked external or blobs aren't enabled on the site), fall back
// to explicit config using env vars the caller sets up manually.
function openStore() {
  try {
    return openStore();
  } catch (err) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) {
      return getStore({ name: STORE, consistency: "strong", siteID, token });
    }
    throw err;
  }
}

// Try multiple strategies to load the discovery manifest. Netlify's esbuild
// bundler doesn't include static files by default, so earlier versions that
// only used process.cwd() silently returned empty arrays. This version tries:
//   1. HTTP fetch from the deploying site (works if discovery.json is public)
//   2. Filesystem reads at common bundle locations (works with included_files)
async function loadDiscovery(event) {
  // Strategy 1: HTTP fetch
  const protocol = event.headers?.["x-forwarded-proto"] || "https";
  const host = event.headers?.host || event.headers?.Host;
  if (host) {
    const base = `${protocol}://${host}`;
    for (const name of ["dashboards.discovery.json", "dashboards.json"]) {
      try {
        const res = await fetch(`${base}/${name}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.dashboards) && data.dashboards.length) return data;
        }
      } catch (err) {
        console.warn(`loadDiscovery HTTP ${name}:`, err.message);
      }
    }
  }

  // Strategy 2: filesystem (requires `included_files` in netlify.toml)
  const roots = [process.cwd(), "/var/task", "/opt/build/repo"];
  for (const root of roots) {
    for (const name of ["dashboards.discovery.json", "dashboards.json"]) {
      try {
        const raw = await fs.readFile(path.join(root, name), "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data?.dashboards) && data.dashboards.length) return data;
      } catch {}
    }
  }

  console.warn("loadDiscovery: manifest not found via any strategy");
  return { dashboards: [] };
}

function merge(discovery, overrides) {
  const map = new Map((overrides.dashboards || []).map(d => [d.slug, d]));
  return {
    ...discovery,
    dashboards: (discovery.dashboards || []).map(d => {
      const ov = map.get(d.slug) || {};
      return {
        ...d,
        allowedRoles: Array.isArray(ov.allowedRoles) ? ov.allowedRoles : (d.allowedRoles || []),
      };
    }),
  };
}

function isAdmin(user) { return (user?.app_metadata?.roles || []).includes("admin"); }
function requireAuth(user) {
  if (!user) return { status: 401, body: { error: "Not authenticated" } };
  return null;
}

export const handler = async (event, context) => {
  const { user } = context.clientContext || {};
  const method = event.httpMethod;

  // Debug endpoint — useful for verifying deploy state. GET /api/config?debug=1
  if (method === "GET" && event.queryStringParameters?.debug === "1") {
    const discovery = await loadDiscovery(event);
    let blob = null, blobError = null, blobStrategy = null;
    // Try auto-context first, then explicit env-var fallback
    try {
      const autoStore = getStore({ name: STORE, consistency: "strong" });
      blob = await autoStore.get(BLOB_KEY, { type: "json" });
      blobStrategy = "auto-context";
    } catch (autoErr) {
      const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
      const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
      if (siteID && token) {
        try {
          const exStore = getStore({ name: STORE, consistency: "strong", siteID, token });
          blob = await exStore.get(BLOB_KEY, { type: "json" });
          blobStrategy = "explicit-env-vars";
        } catch (explicitErr) {
          blobError = `auto: ${autoErr.message} | explicit: ${explicitErr.message}`;
        }
      } else {
        blobError = `${autoErr.message} (and NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN env vars not set)`;
      }
    }
    return send(200, {
      authed: !!user,
      roles: user?.app_metadata?.roles || [],
      discoveryCount: discovery.dashboards?.length || 0,
      discoverySlugs: (discovery.dashboards || []).map(d => d.slug),
      blob, blobStrategy, blobError,
      envVarsPresent: {
        NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
        SITE_ID: !!process.env.SITE_ID,
        NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN,
        NETLIFY_API_TOKEN: !!process.env.NETLIFY_API_TOKEN,
        NETLIFY_BLOBS_CONTEXT: !!process.env.NETLIFY_BLOBS_CONTEXT,
      },
      host: event.headers?.host,
      siteUrl: process.env.URL,
      deployUrl: process.env.DEPLOY_URL,
    });
  }

  if (method === "GET") {
    const err = requireAuth(user);
    if (err) return send(err.status, err.body);
    const discovery = await loadDiscovery(event);
    let overrides = null;
    let blobWarning = null;
    try {
      const store = openStore();
      overrides = await store.get(BLOB_KEY, { type: "json" });
    } catch (err) {
      blobWarning = err.message;
      console.warn("blob read failed", err.message);
    }
    const merged = merge(discovery, overrides || { dashboards: [] });
    return send(200, {
      ...merged,
      generatedAt: new Date().toISOString(),
      ...(blobWarning ? { blobWarning } : {}),
    });
  }

  if (method === "PUT") {
    const err = requireAuth(user);
    if (err) return send(err.status, err.body);
    if (!isAdmin(user)) return send(403, { error: "Admin role required" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return send(400, { error: "Invalid JSON" }); }

    const incoming = Array.isArray(body.dashboards) ? body.dashboards : null;
    if (!incoming) return send(400, { error: "Body must include `dashboards` array" });

    const clean = incoming
      .filter(d => typeof d?.slug === "string")
      .map(d => ({
        slug: d.slug,
        allowedRoles: Array.isArray(d.allowedRoles)
          ? d.allowedRoles.filter(r => typeof r === "string")
          : [],
      }));

    try {
      const store = openStore();
      await store.setJSON(BLOB_KEY, { dashboards: clean });
      return send(200, { ok: true, count: clean.length });
    } catch (err) {
      return send(500, {
        error: `Can't save permissions: ${err.message}. Enable Netlify Blobs on your site (Site configuration → Blobs) and redeploy, or set NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN env vars.`,
      });
    }
  }

  return send(405, { error: "Method not allowed" });
};

function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}
