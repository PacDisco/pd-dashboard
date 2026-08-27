// test/jotform-attribution.test.mjs
//
// Guards the field matcher in sales-funnel-data.mjs against the bug that made
// the "What applicants say" panel read (Unknown) for every applicant.
//
// The PD application form has a section banner titled "How Did You Find
// Pacific Discovery?" (a control_head, no answer) sitting directly above the
// dropdown that actually holds the answer ("Please let us know how you found
// us"). The original matcher looked for the string "how did you find", hit the
// banner, found no answer, and moved on — so the attribution value was never
// read from any of the 399 submissions.
//
// Every case below is taken from a real submission payload
// (form 240277257210046, submission 6634933340312114645).
//
// Run: node test/jotform-attribution.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "netlify", "functions", "sales-funnel-data.mjs"), "utf8");

// Lift the matcher out of the function module, which can't be imported here:
// it reads env vars and starts HubSpot calls at module scope.
function lift(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker);
  if (s < 0 || e < 0 || e <= s) throw new Error(`could not lift ${startMarker}`);
  return src.slice(s, e);
}
// jfAnswerToString, JF_NON_ANSWER_TYPES and both rank functions sit
// contiguously between these two markers. `eval` inside an ES module can't
// export bindings, so the block is compiled and asked to hand them back.
const helpers = lift("function jfAnswerToString", "async function fetchJotformAttribution");
const { jfAnswerToString, JF_NON_ANSWER_TYPES, attributionFieldRank, emailFieldRank } =
  new Function(`${helpers}
    return { jfAnswerToString, JF_NON_ANSWER_TYPES, attributionFieldRank, emailFieldRank };`)();

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
}

// The real answer object, trimmed to the fields that compete with each other.
const ANSWERS = {
  16: { name: "participantsEmail", text: "Participant's email ", type: "control_email", answer: "reesemitchell319@gmail.com" },
  62: { name: "primaryParent62", text: "Primary parent or guardian email", type: "control_email", answer: "renadean@gmail.com" },
  68: { name: "primaryParent68", text: "Secondary parent or guardian email", type: "control_email" },
  76: { name: "howDid76", text: "How Did You Find Pacific Discovery?", type: "control_head" },
  79: { name: "pleaseState", text: "Please state the name and location of the event (ie: Gap Year Fair at _ High School, College Fair at _ High School, Alternative to College Fair, etc.)", type: "control_textbox" },
  81: { name: "pleaseLet", text: "Please let us know how you found us", type: "control_dropdown", answer: "Go Overseas" },
  82: { name: "advisorOr", text: "Advisor or Educational Consultant Name", type: "control_textbox" },
  83: { name: "wordOf", text: "Word of Mouth Referral Name", type: "control_textbox" },
  86: { name: "whoFound", text: "Who found us?", type: "control_dropdown", answer: "You (the student)" },
};

// Mirrors the per-submission loop in fetchJotformAttribution.
function extract(answers) {
  let email = null, emailRank = -1, primary = null, primaryRank = -1;
  let advisor = null, event = null, wom = null;
  for (const qid of Object.keys(answers)) {
    const q = answers[qid] || {};
    if (JF_NON_ANSWER_TYPES.has(q.type)) continue;
    const name = q.name || "";
    const t = (q.text || "").toLowerCase();
    const val = jfAnswerToString(q.answer);
    if (!val) continue;
    const er = emailFieldRank(name, t);
    if (er > emailRank) { emailRank = er; email = val.toLowerCase(); }
    const pr = attributionFieldRank(name, t);
    if (pr > primaryRank) { primaryRank = pr; primary = val; }
    if (name === "advisorOr" || (t.includes("advisor") && t.includes("consultant"))) advisor = val;
    else if (name === "pleaseState" || t.includes("name and location of the event")) event = val;
    else if (name === "wordOf" || t.includes("word of mouth referral")) wom = val;
  }
  return { email, primary, advisor, event, wom };
}

console.log("\n  real PD application submission:\n");
const got = extract(ANSWERS);
check("reads the attribution answer at all", got.primary === "Go Overseas", `got ${JSON.stringify(got.primary)}`);
check("the section header does not win over the question", got.primary !== "How Did You Find Pacific Discovery?");
check("\"Who found us?\" is not mistaken for the channel", got.primary !== "You (the student)");
check("matches the participant, not the parent", got.email === "reesemitchell319@gmail.com", String(got.email));
check("unanswered detail fields stay null", got.advisor === null && got.event === null && got.wom === null);

console.log("\n  key-order independence:\n");
// Object key order is not contractual. Reversing it must not change the answer.
const reversed = Object.fromEntries(Object.entries(ANSWERS).reverse());
check("same result with keys reversed", extract(reversed).primary === "Go Overseas");
check("same email with keys reversed", extract(reversed).email === "reesemitchell319@gmail.com");

console.log("\n  detail fields when filled:\n");
const withDetail = extract({
  ...ANSWERS,
  81: { ...ANSWERS[81], answer: "Word of Mouth" },
  83: { ...ANSWERS[83], answer: "Sarah Chen" },
});
check("word-of-mouth referral name captured", withDetail.wom === "Sarah Chen", String(withDetail.wom));
check("primary switches with the dropdown", withDetail.primary === "Word of Mouth");

console.log("\n  a form that words the question differently:\n");
// "Personal Details" (240567444620051) asks "How did you hear about us?" and
// labels its email field plainly. Adding it should need no code change.
const otherForm = extract({
  1: { name: "email", text: "Email", type: "control_email", answer: "Someone@Example.com" },
  2: { name: "howDidYouHear", text: "How did you hear about us?", type: "control_dropdown", answer: "Instagram" },
});
check("picks up a differently-worded question", otherForm.primary === "Instagram", String(otherForm.primary));
check("picks up a plainly-labelled email, lowercased", otherForm.email === "someone@example.com", String(otherForm.email));

console.log("\n  parent-only submission:\n");
// If only a parent email is present the record must be skipped, never filed
// against the parent's contact.
const parentOnly = extract({ 62: ANSWERS[62], 81: ANSWERS[81] });
check("never falls back to a parent email", parentOnly.email === null, String(parentOnly.email));

console.log(
  failures.length ? `\nFAILED (${failures.length}): ${failures.join(", ")}\n` : "\nAll checks passed.\n"
);
process.exit(failures.length ? 1 : 0);
