// netlify/functions/config.js
//
// GET  /api/config        → returns merged dashboard manifest (discovery + permissions)
//                           requires any authenticated Identity user
// PUT  /api/config        → replaces the permissions overrides in Netlify Blobs
//                           requires the caller to have the "admin" role
//
// The discovery manifest (generated at build time by scripts/build-manifest.js)
// is the baseline: it lists every dashboard folder and its display metadata.
// Permissions live in a Netlify Blob so admins can edit them at runtime
// without triggering a rebuild.

import { getStore } from "@netlify/blobs";
import fs from "node:fs/promises";
import path from "node:path";

const BLOB_KEY = "permissions";
const STORE = "dashboards";

// Load the discovery manifest that was written at build time.
// This is the source of truth for which dashboards EXIST and their metadata.
async function loadDiscovery() {
  const candidates = [
    path.join(process.cwd(), "dashboards.discovery.json"),
    path.join(process.cwd(), "dashboards.json"),
  ];
  for (const p of candidates) {
    try { return JSON.parse(await fs.readFile(p, "utf8")); }
    catch {}
  }
  return { dashboards: [] };
}

// Merge discovery info with blob-stored permission overrides.
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

function isAdmin(user) {
  const roles = user?.app_metadata?.roles || [];
  return roles.includes("admin");
}

function requireAuth(user) {
  if (!user) return { status: 401, body: { error: "Not authenticated" } };
  return null;
}

export const handler = async (event, context) => {
  const { user } = context.clientContext || {};
  const store = getStore({ name: STORE, consistency: "strong" });
  const method = event.httpMethod;

  if (method === "GET") {
    const err = requireAuth(user);
    if (err) return send(err.status, err.body);
    const [discovery, overrides] = await Promise.all([
      loadDiscovery(),
      store.get(BLOB_KEY, { type: "json" }).catch(() => null),
    ]);
    const merged = merge(discovery, overrides || { dashboards: [] });
    return send(200, { ...merged, generatedAt: new Date().toISOString() });
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

    // Sanitize: only keep { slug, allowedRoles } — everything else comes from discovery.
    const clean = incoming
      .filter(d => typeof d?.slug === "string")
      .map(d => ({
        slug: d.slug,
        allowedRoles: Array.isArray(d.allowedRoles)
          ? d.allowedRoles.filter(r => typeof r === "string")
          : [],
      }));

    await store.setJSON(BLOB_KEY, { dashboards: clean });
    return send(200, { ok: true, count: clean.length });
  }

  return send(405, { error: "Method not allowed" });
};

function send(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
