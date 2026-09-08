// test/cash-module-load.test.mjs
//
// The cheapest test in the repo, and the one that would have caught the bug it
// exists because of: cash-xero-sync shipped with `getBankAccountCurrencies`
// missing from its import block. Nothing referenced it until the scheduled run,
// the call site sat inside a try/catch, and the failure surfaced only as one
// ERROR line in a Netlify log while the function still reported success.
//
// Importing a module executes its import block, and a name that is not exported
// by the module it is imported from throws at load. So: import every cash-*
// module, and for the request handlers assert that the thing Netlify actually
// invokes is a function.
//
// Scoped to the cash forecast on purpose. The older functions in this repo are
// CommonJS and some need googleapis installed; sweeping those in would make this
// fail for reasons that are not bugs, and a test that always fails is a test
// nobody reads.
//
// Run: node test/cash-module-load.test.mjs
// Needs @netlify/blobs resolvable — the real package or a stub.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FUNCTIONS = new URL("../netlify/functions/", import.meta.url).pathname;

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m, e) => { failures++; console.error(`  FAIL ${m}\n       ${e}`); };

async function cashFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await cashFiles(join(dir, entry.name), `${entry.name}/`)));
    else if (/^cash-.*\.mjs$/.test(entry.name)) out.push([prefix + entry.name, join(dir, entry.name)]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

console.log("cash module load");

const files = await cashFiles(FUNCTIONS);
if (files.length < 6) fail("found the cash modules", `only ${files.length} matched — has something moved?`);

for (const [rel, file] of files) {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    fail(`${rel} loads`, err.message);
    continue;
  }
  if (rel.startsWith("_shared/")) {
    pass(`${rel} loads`);
  } else if (typeof mod.default !== "function") {
    fail(`${rel} exports a default handler`, `default is ${typeof mod.default}`);
  } else {
    pass(`${rel} loads and exports a handler`);
  }
}

for (const rel of ["engine.mjs", "model.mjs", "seed.mjs"]) {
  try {
    await import(new URL(`../cash-forecast/${rel}`, import.meta.url).href);
    pass(`cash-forecast/${rel} loads`);
  } catch (err) {
    fail(`cash-forecast/${rel} loads`, err.message);
  }
}

// Scheduled functions carry their cadence in an exported config. A typo there is
// silent too — Netlify just never schedules it.
for (const [rel, file] of files.filter(([r]) => r.endsWith("-sync.mjs"))) {
  const { config } = await import(pathToFileURL(file).href);
  const cron = config?.schedule;
  // Netlify accepts both 5-field cron and the @hourly/@daily shorthands.
  const ok = typeof cron === "string"
    && (/^@(hourly|daily|weekly|monthly|yearly|annually)$/.test(cron.trim())
      || cron.trim().split(/\s+/).length === 5);
  if (!ok) {
    fail(`${rel} declares a schedule`, `got ${JSON.stringify(cron)}`);
  } else {
    pass(`${rel} scheduled "${cron}"`);
  }
}

console.log(failures === 0 ? "\nall cash modules load" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
