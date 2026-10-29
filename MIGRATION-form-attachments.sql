-- MIGRATION-form-attachments.sql
--
-- PDFs of quizzes, referrals, step-1-only applications and Meta lead forms
-- attached to HubSpot contacts (FORM-ATTACHMENTS.md). Idempotent. Run AFTER
-- MIGRATION-apply.sql, MIGRATION-quiz.sql and MIGRATION-referral.sql.
--
-- You don't strictly have to run this: the sync runs the same statements
-- itself on its first pass. It's here so the schema is on record.
--
--   meta_leads              one row per Meta instant-form lead (Graph API)
--   form_attachment_state   run lock + last result
--   *_pdf_* columns         which HubSpot note/file holds the PDF, or why not yet

CREATE TABLE IF NOT EXISTS meta_leads (
  id TEXT PRIMARY KEY, page_id TEXT, form_id TEXT, form_name TEXT,
  created_time TIMESTAMPTZ NOT NULL, email TEXT, field_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb, ad_name TEXT, adset_name TEXT, campaign_name TEXT,
  platform TEXT, is_organic BOOLEAN, hubspot_contact_id TEXT,
  pdf_note_id TEXT, pdf_file_id TEXT, pdf_attached_at TIMESTAMPTZ, pdf_error TEXT, pdf_error_at TIMESTAMPTZ, pdf_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS meta_leads_created_idx ON meta_leads (created_time DESC);
CREATE INDEX IF NOT EXISTS meta_leads_email_idx ON meta_leads (lower(email));
CREATE TABLE IF NOT EXISTS form_attachment_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), lock_until TIMESTAMPTZ, last_run_at TIMESTAMPTZ,
  last_result JSONB NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO form_attachment_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_note_id TEXT;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_file_id TEXT;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_attached_at TIMESTAMPTZ;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_error TEXT;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_error_at TIMESTAMPTZ;
ALTER TABLE quiz_responses ADD COLUMN IF NOT EXISTS pdf_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_note_id TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_file_id TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_attached_at TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_error TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_error_at TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS pdf_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_note_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_file_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_attached_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_error TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_error_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS step1_pdf_attempts INTEGER NOT NULL DEFAULT 0;
