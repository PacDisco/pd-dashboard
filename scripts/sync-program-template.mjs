#!/usr/bin/env node
// Copy the program page template from pd-program-pages into this repo, so the
// editor's preview uses exactly the template the public site builds with.
//
//   npm run sync:template                       # from ../pd-program-pages (sibling checkout)
//   npm run sync:template -- /path/to/repo      # from another checkout
//   npm run sync:template -- https://pd-program-pages.netlify.app   # from the live site
//
// Review the diff before committing — this file runs inside the dashboard.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "program-pages", "template", "render.mjs");
const src = process.argv[2] || path.join(root, "..", "pd-program-pages");

let text;
if (/^https:\/\//.test(src)) {
  const res = await fetch(`${src.replace(/\/+$/, "")}/_pd/render.mjs`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching template`);
  text = await res.text();
} else {
  text = await fs.readFile(path.join(src, "src", "render.mjs"), "utf8");
}
const before = await fs.readFile(dest, "utf8").catch(() => "");
if (before === text) { console.log("Template already in sync."); process.exit(0); }
await fs.writeFile(dest, text);
console.log(`Updated program-pages/template/render.mjs (${before.length} → ${text.length} bytes). Review with git diff, then commit.`);
