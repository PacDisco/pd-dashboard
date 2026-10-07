-- MIGRATION-apply.sql
--
-- Online application (pd-apply) + the Apply Form editor in this dashboard.
-- Idempotent — safe to re-run in the Neon SQL editor.
--
--   apply_forms           the form definition. One row ('pd-application').
--     draft               what editors are working on (autosaved from /apply-form/)
--     published           what apply.pacificdiscovery.org serves. NULL = not live.
--   apply_form_versions   every publish / restore, so an earlier form can be
--                         previewed or restored.
--   applications          one row per applicant, written by pd-apply. Holds the
--                         answers, the Jotform-shaped copies the portals read,
--                         and Jotform / HubSpot sync status.
--   apply_files           uploads (the applicant photo); bytes live in the
--                         pd-apply site's Netlify Blobs store "apply-uploads".

CREATE TABLE IF NOT EXISTS apply_forms (
  id             TEXT PRIMARY KEY,
  draft          JSONB NOT NULL,
  draft_rev      INTEGER NOT NULL DEFAULT 1,
  published      JSONB,
  published_rev  INTEGER,
  published_at   TIMESTAMPTZ,
  published_by   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS apply_form_versions (
  id          BIGSERIAL PRIMARY KEY,
  form_id     TEXT NOT NULL REFERENCES apply_forms(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('publish', 'restore')),
  rev         INTEGER,
  data        JSONB NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS apply_form_versions_form_idx ON apply_form_versions (form_id, created_at DESC);

CREATE TABLE IF NOT EXISTS applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  program             TEXT,
  term                TEXT,
  season              TEXT,
  travel_year         TEXT,
  program_type        TEXT,
  deal_amount         NUMERIC(12, 2),
  status              TEXT NOT NULL DEFAULT 'step1'
                      CHECK (status IN ('step1', 'step2', 'interview', 'paid', 'withdrawn')),
  answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_rev            INTEGER,
  jf_step1            JSONB,
  jf_step2            JSONB,
  step1_at            TIMESTAMPTZ,
  step2_at            TIMESTAMPTZ,
  interview_at        TIMESTAMPTZ,
  interview           JSONB,
  paid_at             TIMESTAMPTZ,
  payment             JSONB,
  hubspot_contact_id  TEXT,
  hubspot_deal_id     TEXT,
  jotform_step1_id    TEXT,
  jotform_step2_id    TEXT,
  sync                JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_lock           TIMESTAMPTZ,
  sync_pending        BOOLEAN NOT NULL DEFAULT false,
  attribution         JSONB,
  ip                  TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS applications_email_idx   ON applications (lower(email));
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC);
CREATE INDEX IF NOT EXISTS applications_step2_idx   ON applications (step2_at DESC) WHERE step2_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS applications_ip_idx      ON applications (ip, created_at);

CREATE TABLE IF NOT EXISTS apply_files (
  id              UUID PRIMARY KEY,
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT,
  size            INTEGER,
  blob_key        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apply_files_app_idx ON apply_files (application_id);

-- The form itself is seeded from the live Jotform forms by the dashboard the
-- first time someone opens /apply-form/ (see netlify/functions/apply-forms.mjs),
-- so there is nothing to insert here.
