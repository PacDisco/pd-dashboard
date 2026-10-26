-- MIGRATION-reminders.sql
--
-- Application-fee reminders (pd-apply's hourly apply-reminders function) and
-- the "continue your application" links they carry. Idempotent — safe to
-- re-run in the Neon SQL editor. Run after MIGRATION-apply.sql.
--
--   applications.reminders          { sent: { "1": { at, to }, … }, skipped: […],
--                                     stopped: { at, by }, closedAt, lastError }
--   applications.link_token_hashes  extra resume tokens, one per emailed link
--                                   (hashed, all kept: an emailed link never stops working). The applicant's
--                                   original browser token keeps working too.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS reminders JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_token_hashes TEXT[] NOT NULL DEFAULT '{}';

-- What the hourly job scans: full application in, fee not paid.
CREATE INDEX IF NOT EXISTS applications_unpaid_idx ON applications (step2_at)
  WHERE paid_at IS NULL AND step2_at IS NOT NULL AND status <> 'withdrawn';
-- Resume links look an application up by any of its link tokens.
CREATE INDEX IF NOT EXISTS applications_link_tokens_idx ON applications USING GIN (link_token_hashes);
