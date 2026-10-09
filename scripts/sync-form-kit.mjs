#!/usr/bin/env node
// Copies the shared engines from a pd-apply checkout so the dashboard matches
// the live site exactly:
//   public/form-kit.mjs        → apply-form/form-kit.mjs      (application + quiz forms)
//   public/quiz-kit.mjs        → apply-form/quiz-kit.mjs      (quiz scoring / lint)
//   public/attribution-kit.mjs → apply-form/ and lead-sources/attribution-kit.mjs (channel rules)
//   node scripts/sync-form-kit.mjs ../pd-apply
// With --check, exits 1 if a pinned copy has drifted.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const root = resolve(args.find((a) => !a.startsWith('--')) || '../pd-apply');
const FILES = [
  ['public/form-kit.mjs', '../apply-form/form-kit.mjs'],
  ['public/quiz-kit.mjs', '../apply-form/quiz-kit.mjs'],
  ['public/attribution-kit.mjs', '../apply-form/attribution-kit.mjs'],
  ['public/attribution-kit.mjs', '../lead-sources/attribution-kit.mjs'],
];
let drift = false;
for (const [from, to] of FILES) {
  const src = resolve(root, from);
  const dest = new URL(to, import.meta.url);
  const a = readFileSync(src, 'utf8');
  const b = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  if (a === b) { console.log(`${to.slice(3)} is up to date.`); continue; }
  if (check) { console.error(`${to.slice(3)} differs from pd-apply — run npm run sync:form-kit`); drift = true; continue; }
  writeFileSync(dest, a);
  console.log(`Updated ${to.slice(3)} from ${src}`);
}
process.exit(drift ? 1 : 0);
