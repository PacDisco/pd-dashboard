#!/usr/bin/env node
// Keep the Unearthed Field Budget page identical to the Pacific Discovery one.
//
// field-budget/index.html is the only source. It works out its brand from the
// URL path, so the Unearthed dashboard is the same file served from
// /ue-field-budget/ — that folder exists (rather than a rewrite) because the
// dashboard manifest, per-dashboard access and tile badges are all keyed on
// top-level folders.
//
// Runs at the start of every Netlify build, so the deployed copy can never lag
// behind. Run it locally after editing field-budget/index.html too, so the
// committed copy matches:
//
//   node scripts/sync-ue-field-budget.mjs           # copy
//   node scripts/sync-ue-field-budget.mjs --check   # exit 1 if out of date
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "field-budget", "index.html");
const dest = path.join(root, "ue-field-budget", "index.html");

const text = fs.readFileSync(src, "utf8");
const before = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;

if (process.argv.includes("--check")) {
  if (before !== text) {
    console.error("ue-field-budget/index.html is out of date — run: node scripts/sync-ue-field-budget.mjs");
    process.exit(1);
  }
  console.log("ue-field-budget/index.html is in sync.");
  process.exit(0);
}

if (before === text) {
  console.log("ue-field-budget/index.html already in sync.");
} else {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  console.log("ue-field-budget/index.html updated from field-budget/index.html.");
}
