#!/usr/bin/env node
/**
 * Scan the repo for dashboard folders and emit the discovery manifest.
 *
 * Outputs:
 *   - dashboards.discovery.json  (committed; the source of truth for which
 *                                 dashboards exist + their default permissions)
 *   - dashboards.json            (same content; kept as a public fallback)
 *   - _redirects                 (coarse edge rules)
 *
 * Discovery rules:
 *   - A dashboard is any top-level folder containing an `index.html`
 *   - Folders in EXCLUDED_DIRS are ignored (case-insensitive)
 *   - Optional per-folder `dashboard.json`:
 *       { "title", "description", "category", "icon",
 *         "owner", "pinned", "colors":[c1,c2], "allowedRoles":[…], "order" }
 *   - Field aliases tolerated: `roles` → `allowedRoles`, `color` → `colors`
 *   - Falls back to <title> + <meta name="description"> in index.html
 *
 * Merge behaviour vs. previous discovery file:
 *   - For folders that still exist: preserve owner-set metadata
 *   - For entries in old discovery with NO corresponding folder: REMOVE
 *     (this is the main behaviour change vs. the old script — kills
 *      stale entries like `report` that drift in the manifest forever)
 *
 * Permissions note:
 *   At runtime, Netlify Blobs (`dashboards/permissions` key) overrides what's
 *   in these files. This script only seeds defaults.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DISCOVERY = path.join(ROOT, "dashboards.discovery.json");
const MANIFEST = path.join(ROOT, "dashboards.json");
const REDIRECTS = path.join(ROOT, "_redirects");

// Roles supported by the system (kept in one place for consistency)
const FUNCTIONAL_ROLES = ["admissions", "outreach", "programs", "operations", "flights", "unearthed"];
const ALL_ROLES = ["admin", ...FUNCTIONAL_ROLES];

// Folders that look like dashboards but aren't
const EXCLUDED_DIRS = new Set([
  "netlify", "scripts", "node_modules",
  ".git", ".netlify", ".github",
  "assets", "public", "dist", "build",
  "db", "docs",
]);

function titleFromHtml(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}
function descFromHtml(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}
function prettifySlug(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Normalize a per-folder dashboard.json:
 *   - `roles` → `allowedRoles`
 *   - `color` (string) → `colors`: [color, color]
 *   - drops unknown keys
 */
function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const out = { ...meta };
  if (!Array.isArray(out.allowedRoles) && Array.isArray(out.roles)) {
    out.allowedRoles = out.roles;
  }
  delete out.roles;
  if (!Array.isArray(out.colors) && typeof out.color === "string") {
    out.colors = [out.color, out.color];
  }
  delete out.color;
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`⚠️  Couldn't parse ${path.relative(ROOT, file)}: ${err.message}`);
    return null;
  }
}

function scan() {
  const folders = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => !EXCLUDED_DIRS.has(e.name.toLowerCase()))
    .map((e) => e.name);

  const out = [];
  for (const folderName of folders) {
    const indexPath = path.join(ROOT, folderName, "index.html");
    if (!fs.existsSync(indexPath)) continue;

    // Slug is always lowercase; URL preserves the original folder name
    const slug = folderName.toLowerCase();

    let meta = {};
    const metaPath = path.join(ROOT, folderName, "dashboard.json");
    if (fs.existsSync(metaPath)) {
      meta = normalizeMeta(readJsonSafe(metaPath) || {});
    }

    let htmlTitle = null, htmlDesc = null;
    try {
      const html = fs.readFileSync(indexPath, "utf8");
      htmlTitle = titleFromHtml(html);
      htmlDesc = descFromHtml(html);
    } catch {}

    out.push({
      slug,
      folderName,
      title: meta.title || htmlTitle || prettifySlug(slug),
      description: meta.description || htmlDesc || "",
      category: meta.category || "General",
      icon: meta.icon || "📊",
      owner: meta.owner || "",
      pinned: !!meta.pinned,
      order: typeof meta.order === "number" ? meta.order : undefined,
      colors: Array.isArray(meta.colors) && meta.colors.length ? meta.colors : undefined,
      allowedRoles: Array.isArray(meta.allowedRoles) ? meta.allowedRoles.slice() : [],
      // URL preserves original folder case (Netlify is case-sensitive)
      url: meta.url || `/${folderName}/`,
      // Which fields were EXPLICITLY set in this folder's dashboard.json.
      // merge() uses this so dashboard.json always wins for fields the author
      // actually set, while still preserving hand-edits to discovery for the rest.
      _explicit: Object.keys(meta),
    });
  }
  return out;
}

/**
 * Merge previous discovery with current scan.
 * Key change from the old script: entries in `existing` that have no
 * matching scanned slug are DROPPED, not retained — this kills stale
 * manifest entries when folders are removed.
 */
function merge(existing, scanned) {
  const prevBySlug = new Map((existing || []).map((d) => [d.slug, d]));
  return scanned.map((s) => {
    const prev = prevBySlug.get(s.slug);
    if (!prev) return s;

    // A field set explicitly in dashboard.json ALWAYS wins (so edits propagate).
    // For fields NOT in dashboard.json, preserve any hand-edit in discovery,
    // else fall back to the auto-detected/scanned default.
    const ex = new Set(s._explicit || []);
    return {
      ...s,
      title:        ex.has("title")        ? s.title        : (nonDefault(prev.title, s.slug, prettifySlug(s.slug)) ? prev.title : s.title),
      description:  ex.has("description")  ? s.description  : (prev.description || s.description),
      category:     ex.has("category")     ? s.category     : (prev.category && prev.category !== "General" ? prev.category : s.category),
      icon:         ex.has("icon")         ? s.icon         : (prev.icon && prev.icon !== "📊" ? prev.icon : s.icon),
      owner:        ex.has("owner")        ? s.owner        : (prev.owner || s.owner),
      pinned:       ex.has("pinned")       ? s.pinned       : (typeof prev.pinned === "boolean" ? prev.pinned : s.pinned),
      order:        ex.has("order")        ? s.order        : (prev.order !== undefined ? prev.order : s.order),
      colors:       ex.has("colors")       ? s.colors       : (prev.colors || s.colors),
      allowedRoles: ex.has("allowedRoles") ? s.allowedRoles : (Array.isArray(prev.allowedRoles) ? prev.allowedRoles : s.allowedRoles),
    };
  });
}
function nonDefault(value, slug, prettified) {
  // True if `value` is set and isn't just the auto-generated title
  return !!value && value !== slug && value !== prettified;
}

function writeRedirects(dashboards) {
  // The edge function (netlify/edge-functions/auth-gate.js) does fine-grained
  // per-dashboard role enforcement at request time using live blob data. This
  // file is a coarse baseline; any user with any functional role gets routed
  // and the edge function refines from there.
  const lines = [
    "# AUTO-GENERATED by scripts/build-manifest.js — do not edit by hand",
    "# Coarse baseline: any authenticated user with a role can reach these paths.",
    "# Fine-grained permissions are enforced by netlify/edge-functions/auth-gate.js.",
    "",
    `/api/config        200!    Role=${ALL_ROLES.join(",")}`,
    `/api/users         200!    Role=admin`,
    `/api/users/*       200!    Role=admin`,
  ];
  for (const d of dashboards) {
    const target = d.url || `/${d.folderName || d.slug}/`;
    // _redirects globs work on the URL path, not the slug
    const pathGlob = target.endsWith("/") ? `${target}*` : `${target}/*`;
    lines.push(`${pathGlob.padEnd(28)} 200!    Role=${ALL_ROLES.join(",")}`);
  }
  lines.push("");
  fs.writeFileSync(REDIRECTS, lines.join("\n"));
}

function main() {
  // Load previous discovery (preferred) or fall back to dashboards.json
  let previous = readJsonSafe(DISCOVERY);
  if (!previous || !Array.isArray(previous.dashboards) || !previous.dashboards.length) {
    previous = readJsonSafe(MANIFEST);
  }
  const existing = (previous && Array.isArray(previous.dashboards)) ? previous.dashboards : [];

  const scanned = scan();
  const merged = merge(existing, scanned);

  // Strip internal-only helpers from public output
  const publicForm = merged.map(({ folderName, _explicit, ...rest }) => rest);

  const payload = {
    generatedAt: new Date().toISOString(),
    dashboards: publicForm,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";
  fs.writeFileSync(DISCOVERY, json);
  fs.writeFileSync(MANIFEST, json);
  writeRedirects(merged);

  // Report
  const droppedSlugs = (existing || [])
    .map((e) => e.slug)
    .filter((slug) => !merged.find((m) => m.slug === slug));

  console.log(`✓ Wrote ${merged.length} dashboard(s) → dashboards.discovery.json + dashboards.json`);
  console.log(`✓ Wrote _redirects`);
  if (droppedSlugs.length) {
    console.log(`✓ Dropped ${droppedSlugs.length} stale entr${droppedSlugs.length === 1 ? "y" : "ies"}: ${droppedSlugs.join(", ")}`);
  }
  console.log("");
  console.log("Dashboards:");
  merged.forEach((d) => {
    const roles = d.allowedRoles?.length ? `[${d.allowedRoles.join(",")}]` : "[admin only]";
    console.log(`  • ${d.slug.padEnd(28)} ${(d.title || "").padEnd(35)} ${roles}`);
  });
}

main();
