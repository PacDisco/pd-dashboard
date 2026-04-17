#!/usr/bin/env node
/**
 * Auto-generate dashboards.json by scanning the repo for dashboard folders.
 *
 * Rules:
 *  - A "dashboard" is any top-level folder containing an index.html
 *  - Folders in EXCLUDED_DIRS are ignored (netlify, scripts, node_modules, etc.)
 *  - Optional per-folder metadata: drop a `dashboard.json` inside a folder like
 *      { "title": "...", "description": "...", "category": "...",
 *        "icon": "📊", "owner": "...", "pinned": true, "colors": ["#hex","#hex"] }
 *  - If no dashboard.json exists, the script falls back to the folder's
 *    index.html <title> and <meta name="description">
 *  - Existing entries in dashboards.json are preserved (merged) so hand-edited
 *    metadata survives rebuilds
 *
 * Run manually:   node scripts/build-manifest.js
 * Run on deploy:  set as Netlify build command (see README).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dashboards.json");

const EXCLUDED_DIRS = new Set([
  "netlify",
  "scripts",
  "node_modules",
  ".git",
  ".netlify",
  ".github",
  "assets",
  "public",
  "dist",
  "build"
]);

function readExisting() {
  try {
    const raw = fs.readFileSync(OUT, "utf8");
    return JSON.parse(raw);
  } catch {
    return { dashboards: [] };
  }
}

function titleFromHtml(html) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? t[1].trim().replace(/\s+/g, " ") : null;
}

function descFromHtml(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  return m ? m[1].trim() : null;
}

function prettifySlug(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(s => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}

function scan() {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  const folders = entries
    .filter(e => e.isDirectory() && !e.name.startsWith(".") && !EXCLUDED_DIRS.has(e.name))
    .map(e => e.name);

  const dashboards = [];
  for (const slug of folders) {
    const folder = path.join(ROOT, slug);
    const indexPath = path.join(folder, "index.html");
    if (!fs.existsSync(indexPath)) continue;

    let meta = {};
    const metaPath = path.join(folder, "dashboard.json");
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
      catch (err) { console.warn(`Couldn't parse ${metaPath}:`, err.message); }
    }

    let htmlTitle = null, htmlDesc = null;
    try {
      const html = fs.readFileSync(indexPath, "utf8");
      htmlTitle = titleFromHtml(html);
      htmlDesc = descFromHtml(html);
    } catch {}

    dashboards.push({
      slug,
      title: meta.title || htmlTitle || prettifySlug(slug),
      description: meta.description || htmlDesc || "",
      category: meta.category || "General",
      icon: meta.icon || "📊",
      owner: meta.owner || "",
      pinned: meta.pinned || false,
      colors: meta.colors || undefined,
      url: meta.url || `/${slug}/`
    });
  }
  return dashboards;
}

function merge(existing, scanned) {
  // Preserve hand-edited fields on existing entries; add new ones; drop missing.
  const byslug = new Map(existing.map(d => [d.slug, d]));
  return scanned.map(scan => {
    const prev = byslug.get(scan.slug);
    if (!prev) return scan;
    // Prefer current filesystem for title/description when no dashboard.json
    return {
      ...prev,
      ...scan,
      // If the existing entry had a manual title/description/category etc,
      // keep those rather than overwriting with scanned defaults.
      title: prev.title && prev.title !== scan.slug ? prev.title : scan.title,
      description: prev.description || scan.description,
      category: prev.category || scan.category,
      icon: prev.icon || scan.icon,
      owner: prev.owner || scan.owner,
      pinned: prev.pinned ?? scan.pinned,
      colors: prev.colors || scan.colors,
      url: scan.url
    };
  });
}

function main() {
  const existing = readExisting();
  const scanned = scan();
  const merged = merge(existing.dashboards || [], scanned);

  const payload = {
    generatedAt: new Date().toISOString(),
    dashboards: merged
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${merged.length} dashboard(s) → ${path.relative(ROOT, OUT)}`);
  merged.forEach(d => console.log(`  • ${d.slug.padEnd(20)} ${d.title}`));
}

main();
