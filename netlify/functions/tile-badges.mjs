// netlify/functions/tile-badges.mjs
//
// GET  /api/tile-badges                 → { badges: { slug: { count, capped, label } } }
//        counts of submissions that arrived since the caller last opened each
//        dashboard — only for dashboards they may open.
// POST /api/tile-badges { slug }        → mark that dashboard as seen now.
//        Called by the landing page when a tile is clicked, and by the edge
//        auth gate whenever the dashboard's page is loaded directly.
//
// Needs a verified Identity session (cookie or Bearer). See TILE-BADGES.md.

import fs from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { verifiedUser } from "./_shared/identity.mjs";
import { canAccess, normalizeGrants } from "../edge-functions/lib/dashboard-access.js";
import { BADGED_SLUGS } from "../edge-functions/lib/tile-badges.js";
import { badgeLabel, badgeStore, countNew, latestCursor, readSeen, writeSeen } from "./_shared/tile-badges.mjs";
import { SOURCES, snapshot } from "./_shared/tile-badge-sources.mjs";

const SNAP_TTL_MS = 60 * 1000;     // one upstream call per source per minute, shared by everyone
const _snapCache = new Map();      // slug -> { at, snap }
export function _clearSnapCacheForTests() { _snapCache.clear(); }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function cachedSnapshot(slug, { fresh = false } = {}) {
  const hit = _snapCache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < SNAP_TTL_MS) return hit.snap;
  const snap = await snapshot(slug);
  _snapCache.set(slug, { at: Date.now(), snap });
  return snap;
}

// ── who may see which tile ──────────────────────────────────────────────────

function dashboardsStore() {
  try {
    return getStore({ name: "dashboards", consistency: "strong" });
  } catch (err) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "dashboards", consistency: "strong", siteID, token });
    return null;
  }
}

async function loadManifest(req) {
  for (const root of [process.cwd(), "/var/task", "/opt/build/repo"]) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(root, "dashboards.discovery.json"), "utf8"));
      if (Array.isArray(data?.dashboards)) return data.dashboards;
    } catch {}
  }
  try {
    const res = await fetch(new URL("/dashboards.discovery.json", req.url));
    if (res.ok) return (await res.json()).dashboards || [];
  } catch {}
  return [];
}

/** slug → may this person open it? Same rule as the edge gate and /api/config. */
async function accessChecker(req, user) {
  const store = dashboardsStore();
  const [manifest, overrides, grantsRaw] = await Promise.all([
    loadManifest(req),
    store ? store.get("permissions", { type: "json" }).catch(() => null) : null,
    store ? store.get("grants", { type: "json" }).catch(() => null) : null,
  ]);
  const grants = grantsRaw ? normalizeGrants(grantsRaw) : null;
  const ov = new Map((overrides?.dashboards || []).map((d) => [d.slug, d]));
  const bySlug = new Map(manifest.map((d) => [String(d.slug).toLowerCase(), d]));
  return (slug) => {
    const base = bySlug.get(slug);
    if (!base) return false;
    const o = ov.get(slug);
    const dashboard = o && Array.isArray(o.allowedRoles) ? { ...base, allowedRoles: o.allowedRoles } : base;
    return canAccess({ email: user.email, roles: user.roles, slug, dashboard, grants });
  };
}

// ── handler ─────────────────────────────────────────────────────────────────

export default async (req) => {
  const user = await verifiedUser(req, "tile-badges");
  if (!user || !user.email) return json({ error: "Not authenticated" }, 401);

  const slugs = Object.keys(SOURCES).filter((s) => BADGED_SLUGS.has(s));
  const store = badgeStore();

  if (req.method === "GET") {
    const may = await accessChecker(req, user);
    const mine = slugs.filter(may);
    const seen = await readSeen(user.email, store);

    const results = await Promise.allSettled(mine.map((s) => cachedSnapshot(s)));
    const badges = {};
    let baselined = false;

    results.forEach((r, i) => {
      const slug = mine[i];
      if (r.status !== "fulfilled") {
        console.warn(`[tile-badges] ${slug}: ${r.reason?.message || r.reason}`);
        return;                                   // no bubble beats a wrong bubble
      }
      const rec = seen[slug];
      if (!rec) {
        // First time we've seen this person here: start counting from now.
        seen[slug] = { c: latestCursor(r.value), at: new Date().toISOString(), baseline: true };
        baselined = true;
        badges[slug] = { count: 0, capped: false, label: "" };
        return;
      }
      const n = countNew(r.value, rec.c);
      badges[slug] = { ...n, label: badgeLabel(n), since: rec.at };
    });

    if (baselined) await writeSeen(user.email, seen, store).catch((e) => console.warn("[tile-badges] baseline write:", e.message));
    return json({ badges, generatedAt: new Date().toISOString() });
  }

  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch {}
    const slug = String(body.slug || "").trim().toLowerCase();
    if (!slugs.includes(slug)) return json({ ok: true, ignored: true });

    const may = await accessChecker(req, user);
    if (!may(slug)) return json({ error: "No access to that dashboard" }, 403);

    let snap;
    try {
      snap = await cachedSnapshot(slug, { fresh: true });
    } catch (e) {
      // Can't read the source right now — leave their cursor alone so the
      // bubble is merely late to clear rather than wrong.
      console.warn(`[tile-badges] seen ${slug}: ${e.message}`);
      return json({ ok: false, error: "Source unavailable" }, 502);
    }

    const seen = await readSeen(user.email, store);
    seen[slug] = { c: latestCursor(snap), at: new Date().toISOString() };
    await writeSeen(user.email, seen, store);
    return json({ ok: true, slug });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/tile-badges" };
