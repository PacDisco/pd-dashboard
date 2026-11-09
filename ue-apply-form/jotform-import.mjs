// jotform-import.mjs — turns the live Unearthed Jotform application form
// (GET /form/{id}/questions + /form/{id}/properties) into the ue-apply form
// schema, keeping every Jotform field ID (qid) so applications made on the new
// site land in the same Jotform fields the portals already read.
//
// Pure — no I/O. The dashboard API fetches the two Jotform responses and calls
// jotformToSchema(). Everything it decides is listed in `report` so the editor
// can show what to check.

const KEYS = [
  // [label pattern, key, extra] — the fields the flow / HubSpot / portals rely on
  [/name.*passport|^student'?s? (full )?name$|^full name$/i, 'name', { step: 'step1' }],
  [/student.*e-?mail|^e-?mail( address)?$/i, 'email', { step: 'step1' }],
  [/date of birth|^dob$/i, 'dob', { step: 'step1' }],
  [/student.*(mobile|phone)|^mobile( number)?$/i, 'mobile', { step: 'step1' }],
  [/primary contact name/i, 'parent1Name'],
  [/primary contact e-?mail/i, 'parent1Email'],
  [/primary contact phone/i, 'parent1Phone'],
  [/relationship to student/i, 'parent1Relationship'],
  [/secondary (emergency )?contact name/i, 'parent2Name'],
  [/secondary (emergency )?contact e-?mail/i, 'parent2Email'],
  [/secondary (emergency )?contact phone/i, 'parent2Phone'],
  [/secondary (emergency )?contact relationship/i, 'parent2Relationship'],
  [/what program are you attending/i, 'program', { type: 'hidden', source: 'trip:name' }],
  [/what school do you attend/i, 'school', { prefill: 'trip:school' }],
  [/^currency$/i, 'currency', { type: 'hidden', source: 'trip:currency' }],
  [/completely read and signed the permissions packet/i, 'waiverSigned', { type: 'hidden', source: 'waiver:signed' }],
];

const TYPE = {
  control_textbox: 'text', control_textarea: 'textarea', control_email: 'email', control_phone: 'phone',
  control_number: 'number', control_spinner: 'number', control_datetime: 'date', control_birthdate: 'date',
  control_fullname: 'fullname', control_address: 'address', control_dropdown: 'select', control_radio: 'radio',
  control_checkbox: 'checkbox', control_fileupload: 'file', control_text: 'html', control_yesno: 'radio',
};
const SKIP = /^control_(button|image|pagebreak|head|captcha|signature|divider|collapse|separator)$|payment|stripe|paypal|square|braintree|authnet/i;
const SENSITIVE = /medical|health|mental|suicid|self-harm|substance|allerg|medication|condition|hospital|passport|asthma|diabetes|migraine|skin|neurolog|claustro|blood|immunis|weight|height|anxiety|disorder|swimmer/i;
// Text blocks about the old in-form payment / waiver step — hidden (the new
// flow has its own permissions + deposit steps); unhide in the editor if wanted.
const OLD_STEP_TEXT = /permissions packet|program deposit below|pay your|payment is required/i;

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const camel = (s) => {
  const w = strip(s).replace(/\*\*/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 5);
  const k = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('');
  return /^[A-Za-z]/.test(k) ? k : `q${k}`;
};
const yes = (v) => String(v || '').toLowerCase() === 'yes';

/**
 * @param questions  Jotform /form/{id}/questions content ({ qid: question })
 * @param properties Jotform /form/{id}/properties content (for conditions)
 * @param formId     the Jotform form id (stored as settings.jotform.formId)
 * @returns { schema, report: [string] }
 */
export function jotformToSchema(questions, properties = {}, formId = '') {
  const report = [];
  const list = Object.values(questions || {}).filter(Boolean).sort((a, b) => Number(a.order) - Number(b.order));
  const used = new Set();
  const byQid = new Map();
  const fields = [];   // { field, step, sectionIdx }
  const sections = [{ key: 's1', title: 'About the student', intro: '' }];
  let sec = 0;
  const startSection = (title) => {
    const cur = sections[sec];
    const empty = !fields.some((f) => f.sectionIdx === sec);
    if (empty) { if (title) cur.title = title; return; }
    sections.push({ key: `s${sections.length + 1}`, title: title || '', intro: '' });
    sec = sections.length - 1;
  };

  // The passport widget (Drive link answer) can't take an uploaded file from
  // the new site; the hidden classic upload field (e.g. "Passport Cover Page
  // Photo") can, and the portals read both. Use that field's ID for the passport.
  const passportUpload = list.find((q) => q.type === 'control_fileupload' && /passport/i.test(strip(q.text)));

  for (const q of list) {
    const label = strip(q.text);
    if (q.type === 'control_pagebreak') { startSection(''); continue; }
    if (q.type === 'control_head') { startSection(label); continue; }
    if (SKIP.test(q.type)) { if (/payment|stripe/i.test(q.type)) report.push(`Left out "${label || q.type}" (the old payment field — the new flow takes the deposit itself).`); continue; }

    let type = TYPE[q.type];
    let qid = String(q.qid);
    let jf = { name: q.name || '', type: q.type };
    if (q.type === 'control_widget') {
      if (q.name === 'passportPhoto' || /passport/i.test(label)) {
        if (passportUpload) {
          type = 'file'; qid = String(passportUpload.qid); jf = { name: passportUpload.name || '', type: 'control_fileupload' };
          report.push(`"${label}" (passport-check widget) becomes a passport upload saved into Jotform field ${qid} ("${strip(passportUpload.text)}"), which the portals already read.`);
        } else {
          type = 'file'; jf = { ...jf, mirror: false };
          report.push(`"${label}" is a Jotform widget with no classic upload field to copy into — the file is kept on the application but not sent to Jotform. Check this one.`);
        }
      } else {
        type = 'text';
        report.push(`"${label}" is a Jotform widget (${q.cfname || 'custom'}) — imported as short text. Check this one.`);
      }
    }
    if (!type) { report.push(`Skipped "${label}" (${q.type} isn't supported).`); continue; }
    if (type === 'file' && passportUpload && q.qid === passportUpload.qid && list.some((x) => x.type === 'control_widget' && (x.name === 'passportPhoto' || /passport/i.test(strip(x.text))))) continue; // merged into the widget's place

    const hit = KEYS.find(([re, k]) => re.test(label) && !used.has(k));
    let key = hit ? hit[1] : (/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(q.name || '') ? q.name : camel(label));
    while (used.has(key)) key = `${key}_${q.qid}`;
    used.add(key);
    const extra = hit ? hit[2] || {} : {};

    const field = { key, qid, type: extra.type || type, label: type === 'html' ? (label.slice(0, 80) || 'Text') : label };
    if (type === 'html') field.html = String(q.text || '');
    if (q.subLabel && type !== 'html') field.help = strip(q.subLabel);
    if (yes(q.required) && field.type !== 'hidden') field.required = true;
    if (yes(q.hidden)) field.hidden = true;
    if (type === 'html' && OLD_STEP_TEXT.test(label)) { field.hidden = true; report.push(`Hid the text "${label.slice(0, 60)}…" — it describes the old in-form waiver/payment.`); }
    if (['select', 'radio', 'checkbox'].includes(field.type)) {
      field.options = String(q.options || '').split('|').map((s) => s.trim()).filter(Boolean);
      if (q.type === 'control_yesno' && !field.options.length) field.options = ['Yes', 'No'];
      if (!field.options.length) { field.type = 'text'; report.push(`"${label}" had no options — imported as short text.`); }
    }
    if (field.type === 'file') { field.accept = 'image/*,.pdf,.heic'; field.maxMb = 10; }
    if (extra.source) field.source = extra.source;
    if (extra.prefill) field.prefill = extra.prefill;
    if (SENSITIVE.test(label) && field.type !== 'html' && !['name', 'email', 'dob'].includes(key)) field.sensitive = true;
    field.jf = jf;
    const step = extra.step || 'step2';
    fields.push({ field, step, sectionIdx: step === 'step1' ? -1 : sec });
    byQid.set(String(q.qid), key);
  }

  // Conditions: Jotform "Show field" rules become showIf on the target.
  let conds = 0;
  for (const c of properties?.conditions || []) {
    if (c.type && c.type !== 'field') continue;
    let terms; let actions;
    try { terms = typeof c.terms === 'string' ? JSON.parse(c.terms) : c.terms; actions = typeof c.action === 'string' ? JSON.parse(c.action) : c.action; } catch { continue; }
    const rules = (terms || []).map((t) => ({ field: byQid.get(String(t.field)), op: ({ equals: 'equals', notEquals: 'notEquals', isFilled: 'isFilled', isEmpty: 'isEmpty', contains: 'contains' })[t.operator], value: t.value ?? '' })).filter((r) => r.field && r.op);
    if (!rules.length) continue;
    for (const a of actions || []) {
      if (!/^show/i.test(String(a.visibility || ''))) continue;
      const targets = a.fields ? (Array.isArray(a.fields) ? a.fields : [a.fields]) : [a.field];
      for (const t of targets) {
        const key = byQid.get(String(t));
        const f = fields.find((x) => x.field.key === key)?.field;
        if (!f) continue;
        const prev = f.showIf?.rules || [];
        f.showIf = { match: prev.length ? 'any' : (String(c.link).toLowerCase() === 'all' ? 'all' : 'any'), rules: [...prev, ...rules] };
        conds += 1;
      }
    }
  }
  if (conds) report.push(`Copied ${conds} "show this question when…" rules from Jotform.`);

  for (const k of ['name', 'email', 'dob', 'parent1Name', 'parent1Email']) {
    if (!fields.some((f) => f.field.key === k)) report.push(`Couldn't find the "${k}" question — add it in the editor before publishing.`);
  }

  const step1 = { key: 'step1', title: 'About you', intro: '', submitLabel: 'Continue', sections: [{ key: 'about', title: '', intro: '', fields: fields.filter((f) => f.step === 'step1').map((f) => f.field) }] };
  const step2 = {
    key: 'step2', title: 'Your application', intro: '', submitLabel: 'Submit application',
    sections: sections.map((s, i) => ({ ...s, fields: fields.filter((f) => f.step === 'step2' && f.sectionIdx === i).map((f) => f.field) })).filter((s) => s.fields.length),
  };
  return {
    schema: {
      kind: 'ue-application',
      settings: { cardFeeRate: 0.03, jotform: { formId: String(formId || '') }, texts: {}, emails: {} },
      steps: [step1, step2],
      importedFrom: { formId: String(formId || ''), at: new Date().toISOString(), questions: list.length },
    },
    report,
  };
}
