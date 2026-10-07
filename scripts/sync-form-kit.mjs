#!/usr/bin/env node
// Copies the form engine from a pd-apply checkout into apply-form/ so the
// editor preview and validation match the live application exactly.
//   node scripts/sync-form-kit.mjs ../pd-apply
// With --check, exits 1 if the pinned copy has drifted.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const src = resolve(args.find((a) => !a.startsWith('--')) || '../pd-apply', 'public/form-kit.mjs');
const dest = new URL('../apply-form/form-kit.mjs', import.meta.url);
const a = readFileSync(src, 'utf8');
const b = readFileSync(dest, 'utf8');
if (a === b) { console.log('apply-form/form-kit.mjs is up to date.'); process.exit(0); }
if (check) { console.error('apply-form/form-kit.mjs differs from pd-apply — run npm run sync:form-kit'); process.exit(1); }
writeFileSync(dest, a);
console.log(`Updated apply-form/form-kit.mjs from ${src}`);
