-- MIGRATION-quiz.sql
--
-- Gap-year quiz on apply.pacificdiscovery.org/quiz (pd-apply). Idempotent —
-- safe to re-run in the Neon SQL editor. Run AFTER MIGRATION-apply.sql.
--
-- The quiz definition lives in apply_forms as the row 'pd-quiz' (edited in
-- the dashboard: Apply Form → Quiz). Each completed quiz is one row here.

CREATE TABLE IF NOT EXISTS quiz_responses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,
  answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  scores              JSONB,
  archetype           TEXT,
  form_rev            INTEGER,
  attribution         JSONB,
  hubspot_contact_id  TEXT,
  sync                JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip                  TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quiz_responses_created_idx ON quiz_responses (created_at DESC);
CREATE INDEX IF NOT EXISTS quiz_responses_email_idx   ON quiz_responses (lower(email));
CREATE INDEX IF NOT EXISTS quiz_responses_ip_idx      ON quiz_responses (ip, created_at);
