/**
 * Instructor Management — single Netlify Function with action routing.
 * Backs the "Instructors" admin dashboard.
 *
 * Data model (see MIGRATION-instructors.sql):
 *   instructors            one profile per person, keyed by email
 *   instructor_assignments manually-maintained program-leading history
 *   instructor_documents   cached index of Jotform file uploads
 *   instructor_onboarding  contract / policy-form completion, inferred on sync
 *
 * Routes (query ?action=... or JSON body { action }):
 *   GET   list                       -> { instructors:[...with weeks_led/programs_led], programs:[...], languages:[...], regions:[...], qualifications:[...] }
 *   GET   get            ?id=         -> { instructor, assignments, documents, onboarding }
 *   POST  create                     -> { email, full_name?, status?, ...profile }
 *   POST  update                     -> { id, patch:{...} }
 *   POST  delete                     -> { id }
 *   POST  add-assignment             -> { instructor_id, program, season?, year?, weeks?, role?, notes? }
 *   POST  update-assignment          -> { id, patch:{...} }
 *   POST  delete-assignment          -> { id }
 *   POST  set-onboarding             -> { instructor_id, item, completed }
 *   POST  sync                       -> pull applications / uploads / policy acks from Jotform
 *                                        -> { created, updated, documents, onboarding }
 *
 * Env vars:
 *   NETLIFY_DATABASE_URL   (Neon; auto-injected by Netlify DB)
 *   JOTFORM_API_KEY        (same key used by jotform.js)
 */

const { neon } = require('@neondatabase/serverless');
const https = require('https');

let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function ok(body)             { return { statusCode: 200, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify(body) }; }
function bad(msg, code = 400) { return { statusCode: code, headers: { ...JSON_HEADERS, ...CORS_HEADERS }, body: JSON.stringify({ error: msg }) }; }

const STATUSES = ['current', 'potential', 'new_applicant', 'blacklisted'];

// --------------------------------------------------------------------------
// Jotform form registry. Adjust IDs here if forms are replaced.
// role: 'application' seeds the profile; 'upload' contributes documents;
//       'onboarding' toggles an onboarding checklist item on submission.
// --------------------------------------------------------------------------
const FORMS = [
  { id: '241888714639876', title: 'PD Program Instructor Application', role: 'application' },
  { id: '261607538438868', title: 'Instructor Document Upload Form',   role: 'upload' },
  { id: '261748248196873', title: 'Instructor Personal Information',   role: 'onboarding', item: 'personal_info',       label: 'Personal Information', seedsProfile: true },
  { id: '261722834653056', title: 'Instructor Device Policy',          role: 'onboarding', item: 'policy_device',       label: 'Device Policy' },
  { id: '261727420881863', title: 'Instructor Drug & Alcohol Policy',  role: 'onboarding', item: 'policy_drug_alcohol', label: 'Drug & Alcohol Policy' },
  { id: '261727594157871', title: 'Instructor Flight Policy',          role: 'onboarding', item: 'policy_flight',       label: 'Flight Policy' },
  { id: '261726712606861', title: 'Instructor Money & Credit Card Policy', role: 'onboarding', item: 'policy_money',    label: 'Money & Credit Card Policy' },
  { id: '261727467730867', title: 'Instructor First Aid Kit Policy',   role: 'onboarding', item: 'policy_first_aid',    label: 'First Aid Kit Policy' },
  { id: '261756536759069', title: 'Van Use Policy & Agreement',        role: 'onboarding', item: 'policy_van',          label: 'Van Use Policy' },
];
const ONBOARDING_ITEMS = FORMS.filter(f => f.role === 'onboarding').map(f => ({ item: f.item, label: f.label }));

// --------------------------------------------------------------------------
// Jotform API helper
// --------------------------------------------------------------------------
function jotformGet(path) {
  const apiKey = process.env.JOTFORM_API_KEY;
  if (!apiKey) return Promise.reject(new Error('JOTFORM_API_KEY not set'));
  const sep = path.includes('?') ? '&' : '?';
  const full = `${path}${sep}apiKey=${apiKey}`;
  return new Promise((resolve, reject) => {
    https.get({ host: 'api.jotform.com', path: full, headers: { 'User-Agent': 'pd-dashboard' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Jotform parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// --- answer extraction helpers -------------------------------------------
function answersArray(sub) {
  const out = [];
  const a = sub.answers || {};
  Object.keys(a)
    .sort((x, y) => (Number(a[x].order || 0) - Number(a[y].order || 0)))
    .forEach((qid) => {
      const q = a[qid];
      if (!q || !q.text) return;
      const val = prettyAnswer(q);
      if (val === '' || val == null) return;
      out.push({ label: String(q.text).replace(/<[^>]+>/g, '').trim(), answer: val, type: q.type });
    });
  return out;
}
function prettyAnswer(q) {
  if (q == null) return '';
  if (q.prettyFormat) return String(q.prettyFormat);
  const v = q.answer;
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    // control_fullname { first, last }, control_address { addr_line1, city, ... }
    return Object.keys(v).map((k) => v[k]).filter(Boolean).join(', ');
  }
  return String(v);
}
function findAnswer(sub, predicate) {
  const a = sub.answers || {};
  for (const qid of Object.keys(a)) {
    const q = a[qid];
    if (!q) continue;
    if (predicate(q)) return q;
  }
  return null;
}
function labelHas(q, ...needles) {
  const t = String(q.text || '').replace(/<[^>]+>/g, '').toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
}
function emailOf(sub) {
  const q = findAnswer(sub, (x) => x.type === 'control_email') ||
            findAnswer(sub, (x) => labelHas(x, 'e-mail', 'email'));
  const raw = q ? (typeof q.answer === 'string' ? q.answer : prettyAnswer(q)) : '';
  return String(raw || '').trim().toLowerCase();
}
function nameOf(sub) {
  const q = findAnswer(sub, (x) => x.type === 'control_fullname') ||
            findAnswer(sub, (x) => x.type !== 'control_email' && labelHas(x, 'name') && !labelHas(x, 'next of kin', 'file', 'nationality'));
  return q ? prettyAnswer(q) : null;
}
function splitList(s) {
  if (!s) return [];
  return String(s).split(/[,;\n/]+/).map((x) => x.trim()).filter(Boolean);
}
function fileUrls(q) {
  const v = q && q.answer;
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return [String(v)];
}
function fileNameFromUrl(u) {
  try { return decodeURIComponent(String(u).split('/').pop().split('?')[0]); }
  catch { return String(u).split('/').pop(); }
}

// --------------------------------------------------------------------------
// LIST
// --------------------------------------------------------------------------
async function handleList() {
  const rows = await sql()`
    SELECT i.*,
           COALESCE(SUM(a.weeks), 0)::int                     AS weeks_led,
           COUNT(DISTINCT a.program)::int                     AS programs_led_count,
           COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.program), NULL), '{}') AS programs_led,
           COALESCE((SELECT COUNT(*) FROM instructor_documents d WHERE d.instructor_id = i.id), 0)::int AS document_count,
           COALESCE((SELECT COUNT(*) FROM instructor_onboarding o WHERE o.instructor_id = i.id AND o.completed), 0)::int AS onboarding_done
    FROM instructors i
    LEFT JOIN instructor_assignments a ON a.instructor_id = i.id
    GROUP BY i.id
    ORDER BY
      CASE i.status WHEN 'current' THEN 0 WHEN 'potential' THEN 1 WHEN 'new_applicant' THEN 2 ELSE 3 END,
      lower(i.full_name) NULLS LAST, i.email
  `;
  // Facet lists for filter dropdowns
  const programs = new Set(), languages = new Set(), regions = new Set(), quals = new Set(), locations = new Set();
  rows.forEach((r) => {
    (r.programs_led || []).forEach((p) => p && programs.add(p));
    (r.languages || []).forEach((x) => x && languages.add(x));
    (r.regions_experience || []).forEach((x) => x && regions.add(x));
    (r.regions_applying || []).forEach((x) => x && regions.add(x));
    (r.qualifications || []).forEach((x) => x && quals.add(x));
    if (r.location) locations.add(r.location);
  });
  const sortAlpha = (s) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return ok({
    instructors: rows,
    onboarding_items: ONBOARDING_ITEMS,
    facets: {
      programs: sortAlpha(programs),
      languages: sortAlpha(languages),
      regions: sortAlpha(regions),
      qualifications: sortAlpha(quals),
      locations: sortAlpha(locations),
    },
  });
}

// --------------------------------------------------------------------------
// GET one (with children)
// --------------------------------------------------------------------------
async function handleGet(qs) {
  const id = Number(qs.id);
  if (!id) return bad('id required');
  const rows = await sql()`SELECT * FROM instructors WHERE id = ${id}`;
  if (!rows.length) return bad('not found', 404);
  const instructor = rows[0];
  const [assignments, documents, onboarding] = await Promise.all([
    sql()`SELECT * FROM instructor_assignments WHERE instructor_id = ${id} ORDER BY year DESC NULLS LAST, season, program`,
    sql()`SELECT * FROM instructor_documents   WHERE instructor_id = ${id} ORDER BY uploaded_at DESC NULLS LAST, id DESC`,
    sql()`SELECT * FROM instructor_onboarding  WHERE instructor_id = ${id} ORDER BY item`,
  ]);
  return ok({ instructor, assignments, documents, onboarding });
}

// --------------------------------------------------------------------------
// CREATE instructor
// --------------------------------------------------------------------------
const ARRAY_FIELDS = ['languages', 'regions_experience', 'regions_applying', 'qualifications', 'availability', 'tags'];
const BOOL_FIELDS  = ['wfr', 'drivers_licence', 'is_returning', 'prior_participant'];

function toArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null || v === '') return [];
  return splitList(v);
}
function normStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  return STATUSES.includes(s) ? s : 'new_applicant';
}
function lowerEmails(v) {
  return Array.from(new Set(toArray(v).map((e) => String(e).trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e))));
}

async function handleCreate(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/.+@.+\..+/.test(email)) return bad('a valid email is required');
  try {
    const rows = await sql()`
      INSERT INTO instructors (email, alt_emails, full_name, status, gender, phone, location, country_of_birth,
                               nationality, languages, regions_experience, regions_applying, qualifications,
                               wfr, drivers_licence, availability, is_returning, prior_participant, rating, tags, notes)
      VALUES (${email}, ${lowerEmails(body.alt_emails).filter((e) => e !== email)}, ${body.full_name || null},
              ${normStatus(body.status)}, ${body.gender || null},
              ${body.phone || null}, ${body.location || null}, ${body.country_of_birth || null},
              ${body.nationality || null}, ${toArray(body.languages)}, ${toArray(body.regions_experience)},
              ${toArray(body.regions_applying)}, ${toArray(body.qualifications)},
              ${body.wfr == null ? null : !!body.wfr}, ${body.drivers_licence == null ? null : !!body.drivers_licence},
              ${toArray(body.availability)}, ${!!body.is_returning}, ${body.prior_participant == null ? null : !!body.prior_participant},
              ${body.rating == null || body.rating === '' ? null : Number(body.rating)}, ${toArray(body.tags)}, ${body.notes || null})
      RETURNING *
    `;
    return ok({ instructor: rows[0] });
  } catch (e) {
    if (/duplicate key/i.test(e.message)) return bad(`An instructor with email ${email} already exists`, 409);
    throw e;
  }
}

// --------------------------------------------------------------------------
// UPDATE instructor
// --------------------------------------------------------------------------
async function handleUpdate(body) {
  const { id, patch } = body;
  if (!id || !patch || typeof patch !== 'object') return bad('id and patch required');
  const allow = ['full_name', 'status', 'gender', 'phone', 'location', 'country_of_birth', 'nationality',
    'languages', 'regions_experience', 'regions_applying', 'qualifications', 'wfr', 'drivers_licence',
    'availability', 'is_returning', 'prior_participant', 'rating', 'flight_budget', 'flight_budget_currency',
    'alt_emails', 'tags', 'blacklist_reason', 'notes'];
  const sets = [], args = [];
  for (const k of Object.keys(patch)) {
    if (!allow.includes(k)) continue;
    let v = patch[k];
    if (k === 'status')            v = normStatus(v);
    else if (k === 'alt_emails')   v = lowerEmails(v);
    else if (ARRAY_FIELDS.includes(k)) v = toArray(v);
    else if (BOOL_FIELDS.includes(k))  v = (v == null || v === '') ? null : !!v;
    else if (k === 'rating')       v = (v == null || v === '') ? null : Number(v);
    else if (k === 'flight_budget') { const n = Number(v); v = (v === '' || v == null || !Number.isFinite(n) || n < 0) ? null : n; }
    else if (k === 'flight_budget_currency') v = (String(v || 'USD').trim().toUpperCase().slice(0, 3)) || 'USD';
    else if (typeof v === 'string') v = v.trim() === '' ? null : v.trim();
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  if (!sets.length) return bad('no updatable fields in patch');
  args.push(Number(id));
  const rows = await sql().query(
    `UPDATE instructors SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
  if (!rows.length) return bad('not found', 404);
  return ok({ instructor: rows[0] });
}

async function handleDelete(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const rows = await sql()`DELETE FROM instructors WHERE id = ${id} RETURNING id`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: id });
}

// --------------------------------------------------------------------------
// ASSIGNMENTS (program-leading history)
// --------------------------------------------------------------------------
async function handleAddAssignment(body) {
  const instructorId = Number(body.instructor_id);
  const program = String(body.program || '').trim();
  if (!instructorId) return bad('instructor_id required');
  if (!program) return bad('program required');
  const rows = await sql()`
    INSERT INTO instructor_assignments (instructor_id, program, season, year, weeks, role, notes)
    VALUES (${instructorId}, ${program}, ${body.season || null},
            ${body.year ? Number(body.year) : null}, ${Number(body.weeks) || 0},
            ${body.role || null}, ${body.notes || null})
    RETURNING *`;
  return ok({ assignment: rows[0] });
}
async function handleUpdateAssignment(body) {
  const { id, patch } = body;
  if (!id || !patch) return bad('id and patch required');
  const allow = ['program', 'season', 'year', 'weeks', 'role', 'notes'];
  const sets = [], args = [];
  for (const k of Object.keys(patch)) {
    if (!allow.includes(k)) continue;
    let v = patch[k];
    if (k === 'weeks')     v = Number(v) || 0;
    else if (k === 'year') v = (v == null || v === '') ? null : Number(v);
    else if (typeof v === 'string') v = v.trim() === '' ? null : v.trim();
    args.push(v); sets.push(`${k} = $${args.length}`);
  }
  if (!sets.length) return bad('no updatable fields');
  args.push(Number(id));
  const rows = await sql().query(
    `UPDATE instructor_assignments SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
  if (!rows.length) return bad('not found', 404);
  return ok({ assignment: rows[0] });
}
async function handleDeleteAssignment(body) {
  const id = Number(body.id);
  if (!id) return bad('id required');
  const rows = await sql()`DELETE FROM instructor_assignments WHERE id = ${id} RETURNING id`;
  if (!rows.length) return bad('not found', 404);
  return ok({ deleted: id });
}

// --------------------------------------------------------------------------
// ONBOARDING toggle
// --------------------------------------------------------------------------
async function handleSetOnboarding(body) {
  const instructorId = Number(body.instructor_id);
  const item = String(body.item || '').trim();
  if (!instructorId || !item) return bad('instructor_id and item required');
  const meta = ONBOARDING_ITEMS.find((o) => o.item === item);
  const completed = !!body.completed;
  const rows = await sql()`
    INSERT INTO instructor_onboarding (instructor_id, item, label, completed, completed_at)
    VALUES (${instructorId}, ${item}, ${meta ? meta.label : item}, ${completed}, ${completed ? new Date().toISOString() : null})
    ON CONFLICT (instructor_id, item) DO UPDATE
      SET completed = EXCLUDED.completed,
          completed_at = CASE WHEN EXCLUDED.completed THEN COALESCE(instructor_onboarding.completed_at, NOW()) ELSE NULL END,
          label = EXCLUDED.label
    RETURNING *`;
  return ok({ onboarding: rows[0] });
}

// --------------------------------------------------------------------------
// SYNC — pull from Jotform, keyed by email
// --------------------------------------------------------------------------
async function fetchSubmissions(formId) {
  const res = await jotformGet(`/form/${formId}/submissions?limit=1000&orderby=created_at`);
  return (res && Array.isArray(res.content)) ? res.content : [];
}

async function handleSync() {
  let created = 0, updated = 0, docCount = 0, onboardingCount = 0;
  const seenEmails = new Set();

  // Alias resolution: map any known alt email -> that instructor's PRIMARY
  // email, so a submission filed under an alias folds into the same profile.
  const aliasRows = await sql()`SELECT email, alt_emails FROM instructors`;
  const aliasToPrimary = new Map();
  for (const r of aliasRows) {
    (r.alt_emails || []).forEach((a) => { if (a) aliasToPrimary.set(String(a).toLowerCase(), String(r.email).toLowerCase()); });
  }
  const canon = (raw) => { const e = String(raw || '').toLowerCase(); return e ? (aliasToPrimary.get(e) || e) : ''; };

  // 1) Applications — seed / refresh profiles ------------------------------
  const appForm = FORMS.find((f) => f.role === 'application');
  const appSubs = await fetchSubmissions(appForm.id);
  // newest first so the latest application wins for cached answers
  appSubs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const appByEmail = new Map();
  for (const sub of appSubs) {
    const email = canon(emailOf(sub));
    if (!email || appByEmail.has(email)) continue; // keep newest per email
    appByEmail.set(email, sub);
  }

  for (const [email, sub] of appByEmail) {
    seenEmails.add(email);
    const name = nameOf(sub);
    const gender = valFor(sub, (q) => labelHas(q, 'gender'));
    const phone = valFor(sub, (q) => q.type === 'control_phone' || labelHas(q, 'phone number')) ;
    const location = valFor(sub, (q) => q.type === 'control_address' || (labelHas(q, 'address') && !labelHas(q, 'e-mail')));
    const countryBirth = valFor(sub, (q) => labelHas(q, 'country of birth'));
    const nationality = valFor(sub, (q) => labelHas(q, 'nationality'));
    const languages = toArray(valFor(sub, (q) => labelHas(q, 'languages spoken')));
    const regionsApply = toArray(valFor(sub, (q) => labelHas(q, 'which region') && labelHas(q, 'applying')));
    const regionsExp = toArray(valFor(sub, (q) => labelHas(q, 'meaningful travel experience')));
    const wfrRaw = valFor(sub, (q) => labelHas(q, 'wilderness first responder'));
    const wfr = wfrRaw ? /yes|valid|current/i.test(wfrRaw) : null;
    const driverRaw = valFor(sub, (q) => labelHas(q, 'driver licences', 'driver licence', "driver's licence", 'driver licences/qualifications'));
    const driver = driverRaw ? !/^\s*(no|none|n\/a)\s*$/i.test(driverRaw) : null;
    const priorRaw = valFor(sub, (q) => labelHas(q, 'been a participant on a pacific discovery'));
    const prior = priorRaw ? /yes/i.test(priorRaw) : null;
    const quals = collectQualifications(sub, wfr, driver);
    const answers = JSON.stringify(answersArray(sub));
    const appliedAt = sub.created_at ? new Date(sub.created_at).toISOString() : null;

    const res = await sql()`
      INSERT INTO instructors
        (email, full_name, status, gender, phone, location, country_of_birth, nationality,
         languages, regions_experience, regions_applying, qualifications, wfr, drivers_licence,
         prior_participant, applied_at, application_form_id, application_submission_id, application_answers)
      VALUES
        (${email}, ${name}, 'new_applicant', ${gender}, ${phone}, ${location}, ${countryBirth}, ${nationality},
         ${languages}, ${regionsExp}, ${regionsApply}, ${quals}, ${wfr}, ${driver},
         ${prior}, ${appliedAt}, ${appForm.id}, ${sub.id}, ${answers}::jsonb)
      ON CONFLICT (email) DO UPDATE SET
        -- refresh Jotform-sourced cache always
        application_form_id       = EXCLUDED.application_form_id,
        application_submission_id = EXCLUDED.application_submission_id,
        application_answers       = EXCLUDED.application_answers,
        applied_at                = COALESCE(instructors.applied_at, EXCLUDED.applied_at),
        -- only fill profile fields that admins haven't set (never clobber edits)
        full_name          = COALESCE(instructors.full_name, EXCLUDED.full_name),
        gender             = COALESCE(instructors.gender, EXCLUDED.gender),
        phone              = COALESCE(instructors.phone, EXCLUDED.phone),
        location           = COALESCE(instructors.location, EXCLUDED.location),
        country_of_birth   = COALESCE(instructors.country_of_birth, EXCLUDED.country_of_birth),
        nationality        = COALESCE(instructors.nationality, EXCLUDED.nationality),
        languages          = CASE WHEN instructors.languages = '{}' THEN EXCLUDED.languages ELSE instructors.languages END,
        regions_experience = CASE WHEN instructors.regions_experience = '{}' THEN EXCLUDED.regions_experience ELSE instructors.regions_experience END,
        regions_applying   = CASE WHEN instructors.regions_applying = '{}' THEN EXCLUDED.regions_applying ELSE instructors.regions_applying END,
        qualifications     = CASE WHEN instructors.qualifications = '{}' THEN EXCLUDED.qualifications ELSE instructors.qualifications END,
        wfr                = COALESCE(instructors.wfr, EXCLUDED.wfr),
        drivers_licence    = COALESCE(instructors.drivers_licence, EXCLUDED.drivers_licence),
        prior_participant  = COALESCE(instructors.prior_participant, EXCLUDED.prior_participant)
      RETURNING (xmax = 0) AS inserted, id`;
    if (res[0] && res[0].inserted) created++; else updated++;
    const instructorId = res[0].id;

    // application file uploads (CV, photos)
    docCount += await cacheFiles(sub, instructorId, email, appForm.title);
  }

  // 1b) Profile-seeding secondary sources (e.g. Personal Information) ------
  //     Fills blank profile fields and CREATES onboard-only instructors who
  //     never filed an application. Never overwrites admin-edited fields.
  let seededCreated = 0, seededUpdated = 0;
  for (const form of FORMS.filter((f) => f.seedsProfile)) {
    const subs = await fetchSubmissions(form.id);
    subs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const byEmail = new Map();
    for (const sub of subs) { const e = canon(emailOf(sub)); if (e && !byEmail.has(e)) byEmail.set(e, sub); }
    for (const [email, sub] of byEmail) {
      seenEmails.add(email);
      const name = nameOf(sub);
      const phone = valFor(sub, (q) => q.type === 'control_phone' || labelHas(q, 'phone number'));
      const location = valFor(sub, (q) => q.type === 'control_address' || (labelHas(q, 'address') && !labelHas(q, 'e-mail')));
      const answers = JSON.stringify(answersArray(sub));
      const res = await sql()`
        INSERT INTO instructors (email, full_name, status, phone, location, personal_info_answers)
        VALUES (${email}, ${name}, 'current', ${phone}, ${location}, ${answers}::jsonb)
        ON CONFLICT (email) DO UPDATE SET
          personal_info_answers = EXCLUDED.personal_info_answers,
          full_name = COALESCE(instructors.full_name, EXCLUDED.full_name),
          phone     = COALESCE(instructors.phone, EXCLUDED.phone),
          location  = COALESCE(instructors.location, EXCLUDED.location)
        RETURNING (xmax = 0) AS inserted`;
      if (res[0] && res[0].inserted) seededCreated++; else seededUpdated++;
    }
  }
  created += seededCreated; updated += seededUpdated;

  // Build an email -> instructor id map for the remaining forms
  const idRows = await sql()`SELECT id, email FROM instructors`;
  const idByEmail = new Map(idRows.map((r) => [r.email, r.id]));

  // 2) Document upload form ------------------------------------------------
  for (const form of FORMS.filter((f) => f.role === 'upload')) {
    const subs = await fetchSubmissions(form.id);
    for (const sub of subs) {
      const email = canon(emailOf(sub));
      if (!email) continue;
      const instructorId = idByEmail.get(email) || null;
      docCount += await cacheFiles(sub, instructorId, email, form.title);
    }
  }

  // 3) Onboarding forms (contract, personal info, policies) ----------------
  for (const form of FORMS.filter((f) => f.role === 'onboarding')) {
    const subs = await fetchSubmissions(form.id);
    const emails = new Set();
    for (const sub of subs) { const e = canon(emailOf(sub)); if (e) emails.add(e); }
    for (const email of emails) {
      const instructorId = idByEmail.get(email);
      if (!instructorId) continue; // only track for known instructors
      const r = await sql()`
        INSERT INTO instructor_onboarding (instructor_id, item, label, completed, completed_at)
        VALUES (${instructorId}, ${form.item}, ${form.label}, TRUE, NOW())
        ON CONFLICT (instructor_id, item) DO UPDATE
          SET completed = TRUE, completed_at = COALESCE(instructor_onboarding.completed_at, NOW()), label = EXCLUDED.label
        RETURNING id`;
      if (r.length) onboardingCount++;
    }
  }

  return ok({ created, updated, documents: docCount, onboarding: onboardingCount,
              applicants: appByEmail.size, profile_seeded: seededCreated + seededUpdated });
}

// value for the first answer matching a predicate
function valFor(sub, predicate) {
  const q = findAnswer(sub, predicate);
  return q ? (prettyAnswer(q) || null) : null;
}
function collectQualifications(sub, wfr, driver) {
  const out = [];
  if (wfr) out.push('WFR');
  if (driver) out.push("Driver's licence");
  const certs = valFor(sub, (q) => labelHas(q, 'risk management qualifications', 'outdoor, educational or risk'));
  if (certs) splitList(certs).slice(0, 6).forEach((c) => out.push(c));
  return Array.from(new Set(out));
}
async function cacheFiles(sub, instructorId, email, formTitle) {
  const a = sub.answers || {};
  let n = 0;
  const uploadedAt = sub.created_at ? new Date(sub.created_at).toISOString() : null;
  for (const qid of Object.keys(a)) {
    const q = a[qid];
    if (!q || q.type !== 'control_fileupload') continue;
    const urls = fileUrls(q);
    for (const url of urls) {
      const docType = String(q.text || 'Document').replace(/<[^>]+>/g, '').trim().slice(0, 120) || 'Document';
      try {
        const r = await sql()`
          INSERT INTO instructor_documents (instructor_id, email, doc_type, filename, file_url, source_form, submission_id, uploaded_at)
          VALUES (${instructorId}, ${email}, ${docType}, ${fileNameFromUrl(url)}, ${url}, ${formTitle}, ${sub.id}, ${uploadedAt})
          ON CONFLICT (submission_id, file_url) DO UPDATE
            SET instructor_id = COALESCE(instructor_documents.instructor_id, EXCLUDED.instructor_id)
          RETURNING id`;
        if (r.length) n++;
      } catch (e) { /* skip a bad row, keep syncing */ }
    }
  }
  return n;
}

// --------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};
    const body = event.body
      ? (event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body))
      : {};
    const action = qs.action || body.action || (method === 'GET' ? 'list' : null);

    if (method === 'GET'  && action === 'list')              return await handleList();
    if (method === 'GET'  && action === 'get')               return await handleGet(qs);
    if (method === 'POST' && action === 'create')            return await handleCreate(body);
    if (method === 'POST' && action === 'update')            return await handleUpdate(body);
    if (method === 'POST' && action === 'delete')            return await handleDelete(body);
    if (method === 'POST' && action === 'add-assignment')    return await handleAddAssignment(body);
    if (method === 'POST' && action === 'update-assignment') return await handleUpdateAssignment(body);
    if (method === 'POST' && action === 'delete-assignment') return await handleDeleteAssignment(body);
    if (method === 'POST' && action === 'set-onboarding')    return await handleSetOnboarding(body);
    if (method === 'POST' && action === 'sync')              return await handleSync();

    return bad(`unknown action '${action}' for method ${method}`);
  } catch (err) {
    console.error('instructors error:', err);
    return bad(err.message || 'server error', 500);
  }
};
