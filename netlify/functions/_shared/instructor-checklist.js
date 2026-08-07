/**
 * Instructor onboarding checklist — the CANONICAL definition.
 *
 * This module is the single source of truth for "what does an instructor owe
 * us, and have they provided it?". Two consumers share it:
 *
 *   - instructors.js          the admin dashboard's sync + roster
 *   - instructor-checklist.js the read API the instructor PORTAL calls
 *
 * Previously the portal answered this question from a HubSpot contact property
 * (`instructor_documents`) that nothing ever wrote, and the dashboard answered
 * it from `instructor_onboarding` covering only the policy forms. The two lists
 * barely overlapped. Now both read from here, and Postgres is the source of
 * truth; HubSpot is a downstream mirror only.
 *
 * ------------------------------------------------------------------------
 * TWO KINDS OF ITEM
 * ------------------------------------------------------------------------
 *   kind: 'form'      Submitting the Jotform form completes the item.
 *   kind: 'document'  A FILE has to arrive through the Instructor Document
 *                     Upload Form. Picking a document type from that form's
 *                     dropdown and attaching nothing does NOT complete it.
 *
 * ------------------------------------------------------------------------
 * WHOSE SUBMISSION IS IT?
 * ------------------------------------------------------------------------
 * Several forms carry more than one email field — the Personal Information
 * form has the instructor's (qid 6) and a Next-of-Kin's (qid 40). A submission
 * belongs to the FIRST email field in display order, and any field labelled as
 * a third party's is skipped. Crediting every email a form mentions would tick
 * items on the record of whoever was listed as next of kin.
 *
 * CommonJS on purpose: instructors.js is CJS and requires this directly.
 */

'use strict';

// ==========================================================================
// The 14 canonical items, in the order instructors should see them.
// `item` values are the stable keys stored in instructor_onboarding.item —
// the seven pre-existing keys (personal_info, policy_*) are preserved exactly,
// so this is additive against existing data.
// ==========================================================================
const CHECKLIST = [
  // --- Forms ------------------------------------------------------------
  { item: 'contract',            label: 'Signed Contract',            kind: 'form', formId: '261608232937056' },
  { item: 'personal_info',       label: 'Personal Information',       kind: 'form', formId: '261748248196873' },
  { item: 'policy_device',       label: 'Device Policy',              kind: 'form', formId: '261722834653056' },
  { item: 'policy_drug_alcohol', label: 'Drug & Alcohol Policy',      kind: 'form', formId: '261727420881863' },
  { item: 'policy_flight',       label: 'Flight Policy',              kind: 'form', formId: '261727594157871' },
  { item: 'policy_money',        label: 'Money & Credit Card Policy', kind: 'form', formId: '261726712606861' },
  { item: 'policy_first_aid',    label: 'First Aid Kit Policy',       kind: 'form', formId: '261727467730867' },
  { item: 'policy_van',          label: 'Van Use Policy',             kind: 'form', formId: '261756536759069' },
  // --- Documents (all arrive via the upload form) -----------------------
  { item: 'doc_passport',        label: 'Passport',                     kind: 'document' },
  { item: 'doc_drivers_license', label: 'Drivers License',              kind: 'document' },
  { item: 'doc_wfr',             label: 'WFR Certificate',              kind: 'document' },
  { item: 'doc_police_check',    label: 'Police/FBI/Background Check',  kind: 'document' },
  { item: 'doc_photos',          label: '2 Photos',                     kind: 'document' },
  { item: 'doc_visa',            label: 'Visa',                         kind: 'document' },
];

const BY_ITEM   = new Map(CHECKLIST.map((c) => [c.item, c]));
const FORM_ITEM = new Map(CHECKLIST.filter((c) => c.kind === 'form').map((c) => [c.formId, c.item]));

// Forms whose submissions carry the uploaded documents.
const UPLOAD_FORM_IDS = (process.env.INSTRUCTOR_UPLOAD_FORM_IDS || '261607538438868')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ==========================================================================
// Document classification
// ==========================================================================
// The upload form's "What File Are You Uploading?" dropdown uses different
// wording from our checklist labels, so map between the two vocabularies.
// Keys are pre-normalised (see normalise): lowercased, punctuation stripped.
// A null value means "recognised but deliberately not a checklist item".
const DROPDOWN_ALIASES = new Map(Object.entries({
  'passport':                                                'doc_passport',
  'drivers license':                                         'doc_drivers_license',
  'drivers licence':                                         'doc_drivers_license',
  'wfr first aid certification':                             'doc_wfr',
  'wfr certificate':                                         'doc_wfr',
  'first aid certificate':                                   'doc_wfr',
  'police background check':                                 'doc_police_check',
  'police fbi background check':                             'doc_police_check',
  'background check':                                        'doc_police_check',
  '2 photos 1 x action shot 1 full face shot no sunglasses': 'doc_photos',
  '2 photos':                                                'doc_photos',
  'visa':                                                    'doc_visa',
  // Recognised, but there is no checklist item for it. The file is still
  // stored and listed; it just ticks nothing.
  'covid vaccination record':                                null,
}));

// Tried when no exact alias matches — survives the dropdown being re-worded.
const DROPDOWN_PREFIXES = [
  { prefix: '2 photos',      item: 'doc_photos' },
  { prefix: 'drivers licen', item: 'doc_drivers_license' },
  { prefix: 'wfr',           item: 'doc_wfr' },
  { prefix: 'police',        item: 'doc_police_check' },
];

// Filename evidence, matched against the NORMALISED filename (so underscores
// count as separators — JS \b treats "_" as a word character, which silently
// broke every underscore-named file).
//
// This is how a document is credited when the instructor uploaded it into the
// "wrong" field or picked no type at all. The form tells them to "name each
// file appropriately (i.e. 'James Smith - Passport')", so names are usually
// descriptive. It is also the ONLY way Visa can ever be ticked — the dropdown
// has no Visa option.
//
// Keep every pattern specific: a false match here becomes a green tick on a
// document nobody supplied. Generic "photo" is deliberately absent, or
// "Passport photo page.pdf" would tick 2 Photos.
const FILENAME_MATCHERS = [
  { item: 'doc_passport',        re: /\bpassports?\b/ },
  { item: 'doc_drivers_license', re: /\b(drivers? )?licen[cs]es?\b|\bdrivers licen/ },
  { item: 'doc_wfr',             re: /\bwfr\b|\bwilderness first (responder|aid)\b|\bfirst aid\b/ },
  { item: 'doc_police_check',    re: /\bpolice\b|\bfbi\b|\bdbs\b|\bbackground check\b|\bvetting\b|\bcriminal (history|record|check)\b|\bchild protection\b/ },
  { item: 'doc_photos',          re: /\b(action|face|head) ?shots?\b|\b(2|two) photos\b/ },
  { item: 'doc_visa',            re: /\bvisas?\b/,
    not: /\bvisa (debit|credit|card|payment|statement)\b|\b(debit|credit) card\b/ },
];

// Answer types that can carry a document-type value. The live form uses a
// dropdown; older submissions used a plain textbox.
const TYPE_VALUE_TYPES = new Set([
  'control_dropdown', 'control_radio', 'control_textbox', 'control_textarea',
]);

// Email fields belonging to somebody other than the submitter.
const THIRD_PARTY_EMAIL_RE =
  /next of kin|next-of-kin|emergency|referee|reference|guardian|parent|partner|spouse|supervisor|employer|doctor|gp\b/i;

// ==========================================================================
// Text helpers
// ==========================================================================
function normalise(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[’']/g, '')    // driver's -> drivers
    .replace(/[^a-z0-9]+/g, ' ')  // punctuation, slashes AND underscores -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Flatten a Jotform answer into plain strings. Answers arrive as strings,
// arrays, or objects (address / name sub-fields), and any can be null.
function answerValues(answer) {
  if (answer == null) return [];
  if (Array.isArray(answer)) return answer.flatMap(answerValues);
  if (typeof answer === 'object') return Object.values(answer).flatMap(answerValues);
  const s = String(answer).trim();
  return s ? [s] : [];
}

function itemForDropdownValue(value) {
  const n = normalise(value);
  if (!n) return null;
  if (DROPDOWN_ALIASES.has(n)) return DROPDOWN_ALIASES.get(n); // may be null
  for (const { prefix, item } of DROPDOWN_PREFIXES) {
    if (n.startsWith(prefix)) return item;
  }
  return null;
}

function itemsForFilename(name) {
  const n = normalise(name);
  const out = [];
  if (!n) return out;
  for (const { item, re, not } of FILENAME_MATCHERS) {
    if (re.test(n) && !(not && not.test(n))) out.push(item);
  }
  return out;
}

function fileNameFromUrl(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); }
  catch { return String(u).split('/').pop() || ''; }
}

// ==========================================================================
// Submission helpers
// ==========================================================================
// The submitter's own email: the first email field in display order, skipping
// any labelled as a third party's. Returns null when there is none.
function submitterEmail(submission) {
  const answers = (submission && submission.answers) || {};
  let best = null;
  for (const [qid, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object') continue;
    if (String(a.type || '').toLowerCase() !== 'control_email') continue;
    if (THIRD_PARTY_EMAIL_RE.test(String(a.text || a.name || ''))) continue;
    const [value] = answerValues(a.answer);
    if (!value) continue;
    const order = parseInt(a.order, 10);
    const rank = [Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER, parseInt(qid, 10) || 0];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) {
      best = { rank, email: value.toLowerCase() };
    }
  }
  return best ? best.email : null;
}

// Sort answers into display order. `order` is authoritative when present;
// answers missing it sort LAST — collapsing them to 0 put every file field
// ahead of every dropdown on the real upload form (file qids are 4/6/11/12,
// dropdown qids 14-17), which silently broke all pairing.
function orderedAnswers(submission) {
  const answers = (submission && submission.answers) || {};
  if (!answers || typeof answers !== 'object') return [];
  return Object.entries(answers)
    .filter(([, a]) => a && typeof a === 'object')
    .map(([qid, a]) => Object.assign({ qid }, a))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10), oy = parseInt(y.order, 10);
      const fx = Number.isFinite(ox), fy = Number.isFinite(oy);
      if (fx && fy && ox !== oy) return ox - oy;
      if (fx !== fy) return fx ? -1 : 1;
      return (parseInt(x.qid, 10) || 0) - (parseInt(y.qid, 10) || 0);
    });
}

/**
 * Classify ONE upload-form submission.
 *
 * The form is four "What File Are You Uploading?" dropdowns, each followed by
 * an upload field, and it allows several files per field. Two independent
 * kinds of evidence credit a document — and neither will credit one on the
 * strength of a dropdown selection alone:
 *
 *   A. STRUCTURAL PAIRING — a document type is credited when the upload field
 *      that structurally follows it actually holds a file. The pairing is
 *      consumed at that upload field whether or not it holds one, so a type
 *      picked against an empty field is DISCARDED rather than drifting onto
 *      whatever is attached further down.
 *
 *   B. FILENAME EVIDENCE — every uploaded file's own name is matched.
 *
 * Why not credit every type the submission selected? Because a type picked
 * with no file attached is indistinguishable, in aggregate, from a file
 * attached with no type picked — and both occur together on real submissions
 * (8 of the 12 live ones have a type picked with nothing attached). Crediting
 * on selection would put a green tick against a WFR wilderness-first-aid
 * certificate that does not exist. Under-reporting is recoverable — the
 * instructor re-uploads, or an admin ticks the box; a false tick on a safety
 * credential is not. So: no file, no credit.
 *
 * @returns {{ items: string[], files: Array<{url,filename,docType,item}> }}
 */
function classifyUploadSubmission(submission) {
  const items = new Set();
  const files = [];
  let pending = null;

  for (const a of orderedAnswers(submission)) {
    const type = String(a.type || '').toLowerCase();

    if (TYPE_VALUE_TYPES.has(type)) {
      const values = answerValues(a.answer);
      if (values.length) pending = values[values.length - 1];
      continue;
    }
    if (type !== 'control_fileupload') continue;

    // Consume the pending type at THIS field, file or not.
    const claimed = pending;
    pending = null;

    const urls = answerValues(a.answer);
    if (!urls.length) continue;

    // A — structural pairing. Falls back to the upload field's own label,
    // which is meaningful on forms that name their upload fields.
    const pairedItem = itemForDropdownValue(claimed || a.text || a.name || '');
    if (pairedItem) items.add(pairedItem);

    // B — filename evidence, per file.
    for (const url of urls) {
      const filename = fileNameFromUrl(url);
      const byName = itemsForFilename(filename);
      byName.forEach((i) => items.add(i));
      const best = pairedItem || byName[0] || null;
      files.push({
        url,
        filename: filename || 'Document',
        // A human doc_type for the documents table: the checklist label when
        // we know it, else the raw dropdown text, else a generic fallback.
        docType: best ? BY_ITEM.get(best).label : (claimed ? String(claimed).slice(0, 120) : 'Document'),
        item: best,
      });
    }
  }

  return { items: Array.from(items), files };
}

module.exports = {
  CHECKLIST,
  BY_ITEM,
  FORM_ITEM,
  UPLOAD_FORM_IDS,
  CHECKLIST_ITEMS: CHECKLIST.map((c) => ({ item: c.item, label: c.label, kind: c.kind })),
  normalise,
  answerValues,
  submitterEmail,
  orderedAnswers,
  itemForDropdownValue,
  itemsForFilename,
  fileNameFromUrl,
  classifyUploadSubmission,
};
