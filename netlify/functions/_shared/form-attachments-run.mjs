// netlify/functions/_shared/form-attachments-run.mjs
//
// One pass of the form-attachments sync (scheduled every 5 minutes). Puts a
// PDF of every lead/applicant submission on the HubSpot contact, as a note
// with the PDF attached:
//
//   quiz       quiz_responses        (pd-apply /quiz)
//   referral   referrals             (pd-apply /refer) — one note on the
//                                    referrer AND the referred contact
//   step1      applications that stopped at step 1 for FORM_PDF_STEP1_DELAY_MIN
//              (default 30). A full application gets its own PDF from the
//              student-payments sync (application-pdf.mjs), which already
//              includes the step-1 answers, so step 1 is only filed when the
//              applicant hasn't gone on.
//   meta       Meta instant lead forms, read from the Graph API into
//              meta_leads, then matched to the contact HubSpot's Lead Ads sync
//              created (by email). Never creates a contact.
//
// Website popups are attached at submit time (popup-submit → popups-hubspot).
//
// Everything is newest-first, a few per kind per pass, so new submissions
// land within minutes while older ones backfill on their own. A submission
// whose contact isn't in HubSpot yet is retried with backoff (5, 10, 15 …
// minutes, capped at 6 h) up to MAX_ATTEMPTS times.

import { neon } from "@neondatabase/serverless";
import * as hub from "./hubspot-student.mjs";
import { listMetaLeads, metaConfig } from "./meta-leads.mjs";
import { quizPdf, referralPdf, step1Pdf, metaLeadPdf, noteHtml } from "./submission-pdf.mjs";

export const MAX_ATTEMPTS = 30;
const PER_KIND = 6;

let _sql;
export function db() {
  if (!_sql) {
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("NETLIFY_DATABASE_URL not configured");
    _sql = neon(url);
  }
  return _sql;
}
export function __setSql(fn) { _sql = fn; _schemaReady = false; }

let _deps = null;
export function __setDeps(d) { _deps = d; }
const deps = () => _deps || { hub, listMetaLeads, metaConfig };

const q = (text, params = []) => db().query(text, params);

// ── schema (idempotent; same statements as MIGRATION-form-attachments.sql) ──

const PDF_COLS = (p = "pdf") => [
  `${p}_note_id TEXT`, `${p}_file_id TEXT`, `${p}_attached_at TIMESTAMPTZ`,
  `${p}_error TEXT`, `${p}_error_at TIMESTAMPTZ`, `${p}_attempts INTEGER NOT NULL DEFAULT 0`,
];

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS meta_leads (
     id TEXT PRIMARY KEY, page_id TEXT, form_id TEXT, form_name TEXT,
     created_time TIMESTAMPTZ NOT NULL, email TEXT, field_data JSONB NOT NULL DEFAULT '[]'::jsonb,
     questions JSONB NOT NULL DEFAULT '[]'::jsonb, ad_name TEXT, adset_name TEXT, campaign_name TEXT,
     platform TEXT, is_organic BOOLEAN, hubspot_contact_id TEXT,
     ${PDF_COLS().join(", ")},
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS meta_leads_created_idx ON meta_leads (created_time DESC)`,
  `CREATE INDEX IF NOT EXISTS meta_leads_email_idx ON meta_leads (lower(email))`,
  `CREATE TABLE IF NOT EXISTS form_attachment_state (
     id INTEGER PRIMARY KEY CHECK (id = 1), lock_until TIMESTAMPTZ, last_run_at TIMESTAMPTZ,
     last_result JSONB NOT NULL DEFAULT '{}'::jsonb)`,
  `INSERT INTO form_attachment_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  ...PDF_COLS().map((c) => `ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS ${c}`),
  ...PDF_COLS().map((c) => `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ${c}`),
  ...PDF_COLS("step1_pdf").map((c) => `ALTER TABLE applications ADD COLUMN IF NOT EXISTS ${c}`),
];

let _schemaReady = false;
export async function ensureSchema() {
  if (_schemaReady) return [];
  const skipped = [];
  for (const s of SCHEMA_SQL) {
    // quiz_responses / referrals only exist once their migrations ran; skip
    // those kinds rather than failing the whole pass.
    try { await q(s); } catch (e) { skipped.push(`${s.slice(0, 60)}… ${e.message}`); }
  }
  _schemaReady = skipped.length === 0;
  return skipped;
}

// ── lock ────────────────────────────────────────────────────────────────────

async function acquireLock(seconds = 90) {
  const rows = await q(
    `UPDATE form_attachment_state SET lock_until = now() + make_interval(secs => $1)
      WHERE id = 1 AND (lock_until IS NULL OR lock_until < now()) RETURNING id`, [seconds]);
  return rows.length === 1;
}
async function releaseLock(result) {
  await q(`UPDATE form_attachment_state SET lock_until = NULL, last_run_at = now(), last_result = $1 WHERE id = 1`, [JSON.stringify(result)]);
}

// ── form definitions (pd-apply forms are versioned in apply_forms) ──────────

const _schemas = new Map();
export async function schemaFor(formId, rev) {
  const k = `${formId}:${rev ?? "published"}`;
  if (_schemas.has(k)) return _schemas.get(k);
  let schema = null;
  if (rev != null) {
    const [v] = await q(`SELECT data FROM apply_form_versions WHERE form_id = $1 AND rev = $2 ORDER BY created_at DESC LIMIT 1`, [formId, rev]);
    schema = v?.data || null;
  }
  if (!schema) {
    const [f] = await q(`SELECT published, draft FROM apply_forms WHERE id = $1`, [formId]);
    schema = f?.published || f?.draft || null;
  }
  if (!schema) throw new Error(`No ${formId} form definition found`);
  _schemas.set(k, schema);
  return schema;
}

// ── the kinds ───────────────────────────────────────────────────────────────

const retryable = (p = "pdf") =>
  `${p}_note_id IS NULL AND ${p}_attempts < ${MAX_ATTEMPTS}
   AND (${p}_error_at IS NULL OR ${p}_error_at < now() - make_interval(mins => least(5 * ${p}_attempts, 360)))`;

async function contactFor(id, email) {
  if (id) return String(id);
  return email ? deps().hub.contactIdForEmail(email) : null;
}

export const KINDS = {
  quiz: {
    table: "quiz_responses", prefix: "pdf", folder: "Quiz",
    todo: () => `SELECT * FROM quiz_responses WHERE ${retryable()} ORDER BY created_at DESC LIMIT $1`,
    count: () => `SELECT count(*)::int AS n FROM quiz_responses WHERE pdf_note_id IS NULL AND pdf_attempts < ${MAX_ATTEMPTS}`,
    async prepare(row, includePrivate) {
      const schema = await schemaFor("pd-quiz", row.form_rev);
      const pdf = quizPdf({ resp: row, schema, includePrivate });
      const contactId = await contactFor(row.hubspot_contact_id, row.email);
      return { pdf, contactIds: contactId ? [contactId] : [], when: row.created_at, missing: `No HubSpot contact for ${row.email} yet` };
    },
  },
  referral: {
    table: "referrals", prefix: "pdf", folder: "Referrals",
    todo: () => `SELECT * FROM referrals WHERE ${retryable()} ORDER BY created_at DESC LIMIT $1`,
    count: () => `SELECT count(*)::int AS n FROM referrals WHERE pdf_note_id IS NULL AND pdf_attempts < ${MAX_ATTEMPTS}`,
    async prepare(row, includePrivate) {
      const schema = await schemaFor("pd-referral", row.form_rev);
      const pdf = referralPdf({ ref: row, schema, includePrivate });
      const ids = [
        await contactFor(row.referred_contact_id, row.referred_email),
        await contactFor(row.referrer_contact_id, row.referrer_email),
      ].filter(Boolean);
      return { pdf, contactIds: ids, when: row.created_at, missing: `No HubSpot contact for ${row.referred_email} or ${row.referrer_email} yet` };
    },
  },
  step1: {
    table: "applications", prefix: "step1_pdf", folder: "Applications Started",
    todo: () => `SELECT * FROM applications
      WHERE step1_at IS NOT NULL AND step2_at IS NULL AND status <> 'withdrawn'
        AND step1_at < now() - make_interval(mins => ${step1DelayMin()})
        AND ${retryable("step1_pdf")}
      ORDER BY step1_at DESC LIMIT $1`,
    count: () => `SELECT count(*)::int AS n FROM applications
      WHERE step1_at IS NOT NULL AND step2_at IS NULL AND status <> 'withdrawn'
        AND step1_pdf_note_id IS NULL AND step1_pdf_attempts < ${MAX_ATTEMPTS}`,
    async prepare(row, includePrivate) {
      const schema = await schemaFor("pd-application", row.form_rev);
      const pdf = step1Pdf({ app: row, schema, includePrivate });
      const contactId = await contactFor(row.hubspot_contact_id, row.email);
      return { pdf, contactIds: contactId ? [contactId] : [], dealId: row.hubspot_deal_id, when: row.step1_at || row.created_at, missing: `No HubSpot contact for ${row.email} yet` };
    },
  },
  meta: {
    table: "meta_leads", prefix: "pdf", folder: "Meta Lead Forms",
    todo: () => `SELECT * FROM meta_leads WHERE ${retryable()} ORDER BY created_time DESC LIMIT $1`,
    count: () => `SELECT count(*)::int AS n FROM meta_leads WHERE pdf_note_id IS NULL AND pdf_attempts < ${MAX_ATTEMPTS}`,
    async prepare(row) {
      const pdf = metaLeadPdf({ lead: row });
      const contactId = await contactFor(row.hubspot_contact_id, row.email);
      if (contactId && !row.hubspot_contact_id) await q(`UPDATE meta_leads SET hubspot_contact_id = $2 WHERE id = $1`, [row.id, contactId]);
      return {
        pdf, contactIds: contactId ? [contactId] : [], when: row.created_time,
        missing: row.email ? `No HubSpot contact for ${row.email} yet (waiting for HubSpot's Lead Ads sync)` : "The lead has no email to match on",
      };
    },
  },
};

export function step1DelayMin(env = process.env) {
  const n = parseInt(env.FORM_PDF_STEP1_DELAY_MIN, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

const folderRoot = () => (process.env.FORM_PDF_FOLDER || "/Lead Forms").replace(/\/+$/, "");

/** Attach up to `limit` PDFs of one kind. */
export async function attachKind(kind, { deadline, limit = PER_KIND }) {
  const k = KINDS[kind];
  const out = { attached: 0, waiting: 0, errors: 0, remaining: 0 };
  const h = deps().hub;
  const includePrivate = process.env.APPLICATION_PDF_INCLUDE_PRIVATE === "true";
  const p = k.prefix;
  const rows = await q(k.todo(), [limit]);
  for (const row of rows) {
    if (Date.now() > deadline) break;
    try {
      const job = await k.prepare(row, includePrivate);
      if (!job.contactIds.length) {
        out.waiting++;
        await q(`UPDATE ${k.table} SET ${p}_error = $2, ${p}_error_at = now(), ${p}_attempts = ${p}_attempts + 1 WHERE id = $1`, [row.id, job.missing]);
        continue;
      }
      const fileId = await h.uploadFile(job.pdf.bytes, job.pdf.fileName, `${folderRoot()}/${k.folder}`);
      const noteId = await h.createNote({
        body: noteHtml(job.pdf.noteTitle, job.pdf.noteLines),
        fileId, contactIds: job.contactIds, dealId: job.dealId || null,
        timestamp: new Date(job.when || Date.now()).toISOString(),
      });
      await q(
        `UPDATE ${k.table} SET ${p}_note_id = $2, ${p}_file_id = $3, ${p}_attached_at = now(), ${p}_error = NULL, ${p}_error_at = NULL WHERE id = $1`,
        [row.id, noteId, fileId]);
      out.attached++;
    } catch (e) {
      out.errors++;
      console.warn(`[form-attachments] ${kind} ${row.id}:`, e.message);
      await q(`UPDATE ${k.table} SET ${p}_error = $2, ${p}_error_at = now(), ${p}_attempts = ${p}_attempts + 1 WHERE id = $1`, [row.id, String(e.message).slice(0, 500)])
        .catch(() => {});
    }
  }
  const [{ n }] = await q(k.count());
  out.remaining = n;
  return out;
}

// ── Meta ingest ─────────────────────────────────────────────────────────────

export async function metaSince(env = process.env) {
  const [{ latest }] = await q(`SELECT max(created_time) AS latest FROM meta_leads`);
  // Re-read the last 2 hours each time (ON CONFLICT makes it free), so a lead
  // Meta reports a little late isn't skipped.
  if (latest) return new Date(latest).getTime() - 2 * 3_600_000;
  const start = Date.parse(env.META_LEADS_START || "");
  // First run: Meta keeps leads for 90 days, so take all of them.
  return Number.isFinite(start) ? start : Date.now() - 89 * 86_400_000;
}

export async function ingestMeta({ deadline }) {
  const cfg = deps().metaConfig();
  if (!cfg.enabled) return { skipped: "META_LEADS_TOKEN / META_PAGE_IDS not set" };
  const { leads, forms, errors } = await deps().listMetaLeads({ sinceMs: await metaSince(), deadline, cfg });
  let added = 0;
  for (const l of leads) {
    const rows = await q(
      `INSERT INTO meta_leads (id, page_id, form_id, form_name, created_time, email, field_data, questions, ad_name, adset_name, campaign_name, platform, is_organic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [l.id, l.page_id, l.form_id, l.form_name, l.created_time, l.email, JSON.stringify(l.field_data), JSON.stringify(l.questions),
        l.ad_name, l.adset_name, l.campaign_name, l.platform, l.is_organic]);
    if (rows.length) added++;
  }
  return { forms, seen: leads.length, added, ...(errors.length ? { errors } : {}) };
}

// ── one pass ────────────────────────────────────────────────────────────────

export async function runFormAttachments({ budgetMs = 22_000, trigger = "schedule", kinds = Object.keys(KINDS) } = {}) {
  const schemaSkipped = await ensureSchema();
  if (!(await acquireLock())) return { skipped: "locked" };
  const started = Date.now();
  const deadline = started + budgetMs;
  const result = { trigger, startedAt: new Date(started).toISOString() };
  if (schemaSkipped.length) result.schemaSkipped = schemaSkipped;
  try {
    try { result.metaIngest = await ingestMeta({ deadline: started + Math.min(8_000, budgetMs / 2) }); }
    catch (e) { result.metaIngest = { error: e.message }; }
    for (const kind of kinds) {
      if (Date.now() > deadline) { result[kind] = { skipped: "out of time" }; continue; }
      try { result[kind] = await attachKind(kind, { deadline }); }
      catch (e) { result[kind] = { error: e.message }; } // e.g. the table doesn't exist yet
    }
  } finally {
    result.ms = Date.now() - started;
    await releaseLock(result).catch(() => {});
  }
  return result;
}
