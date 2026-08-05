-- ==========================================================================
-- Instructor Management System
-- Run once against your Netlify DB (Postgres / Neon).
-- From your repo root:
--   netlify db exec < MIGRATION-instructors.sql
-- or paste into the Neon SQL editor.
--
-- Safe to re-run (idempotent). Depends on set_updated_at() from db/schema.sql;
-- it is (re)defined here too so this file can run standalone.
-- ==========================================================================

-- Shared updated_at trigger fn (no-op if already present from db/schema.sql)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- instructors: one canonical profile per person, identity keyed by email.
--   Jotform submissions (application, uploads, policy forms) are matched to
--   this row by the lower-cased email. Admin-managed fields (status, tags,
--   blacklist_reason, notes) are things Jotform can't track.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instructors (
  id                     SERIAL PRIMARY KEY,

  -- Identity / join key
  email                  TEXT NOT NULL UNIQUE,           -- stored lower-cased
  full_name              TEXT,

  -- The one thing Jotform can't do: lifecycle status
  status                 TEXT NOT NULL DEFAULT 'new_applicant'
                         CHECK (status IN ('current', 'potential', 'new_applicant', 'blacklisted')),

  -- Profile / filterable attributes (seeded from the application on sync,
  -- then freely editable by admins).
  gender                 TEXT,
  phone                  TEXT,
  location               TEXT,                            -- home base: "Auckland, NZ"
  country_of_birth       TEXT,
  nationality            TEXT,                            -- passport nationality (visa relevance)
  languages              TEXT[]  NOT NULL DEFAULT '{}',   -- other than English
  regions_experience     TEXT[]  NOT NULL DEFAULT '{}',   -- regions with meaningful travel experience
  regions_applying       TEXT[]  NOT NULL DEFAULT '{}',   -- regions applying/wanting to lead in
  qualifications         TEXT[]  NOT NULL DEFAULT '{}',   -- WFR, First Aid, driver, risk-mgmt, etc.
  wfr                    BOOLEAN,                         -- valid Wilderness First Responder (or equiv)
  drivers_licence        BOOLEAN,
  availability           TEXT[]  NOT NULL DEFAULT '{}',   -- seasons/terms they can work
  is_returning           BOOLEAN NOT NULL DEFAULT FALSE,  -- returning instructor vs first-timer
  prior_participant      BOOLEAN,                         -- was a PD / PE participant themselves

  -- Optional performance signal (from feedback / field reports, admin-set)
  rating                 NUMERIC(3, 1),                   -- e.g. 4.5

  -- Admin metadata
  tags                   TEXT[]  NOT NULL DEFAULT '{}',
  blacklist_reason       TEXT,
  notes                  TEXT,

  -- Jotform linkage cache
  applied_at             TIMESTAMPTZ,                     -- application submission date
  application_form_id    TEXT,
  application_submission_id TEXT,
  application_answers    JSONB,                           -- cached [{label, answer}] for the detail view

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS instructors_status_idx        ON instructors (status);
CREATE INDEX IF NOT EXISTS instructors_email_idx         ON instructors (email);
CREATE INDEX IF NOT EXISTS instructors_languages_idx     ON instructors USING GIN (languages);
CREATE INDEX IF NOT EXISTS instructors_regions_exp_idx   ON instructors USING GIN (regions_experience);
CREATE INDEX IF NOT EXISTS instructors_quals_idx         ON instructors USING GIN (qualifications);
CREATE INDEX IF NOT EXISTS instructors_tags_idx          ON instructors USING GIN (tags);

DROP TRIGGER IF EXISTS instructors_set_updated_at ON instructors;
CREATE TRIGGER instructors_set_updated_at
  BEFORE UPDATE ON instructors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- instructor_assignments: manually-maintained program-leading history.
--   This is the source of "weeks of program led" and "previous programs led".
--   weeks_led / programs_led on the roster are computed by aggregating here.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instructor_assignments (
  id             SERIAL PRIMARY KEY,
  instructor_id  INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  program        TEXT NOT NULL,                    -- "Bali", "South America Semester", ...
  season         TEXT,                             -- Spring | Summer | Fall | Winter
  year           INTEGER,
  weeks          INTEGER NOT NULL DEFAULT 0,       -- weeks led on this program
  role           TEXT,                             -- Lead | Co-Instructor | Assistant
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS instructor_assignments_instructor_idx ON instructor_assignments (instructor_id);
CREATE INDEX IF NOT EXISTS instructor_assignments_program_idx    ON instructor_assignments (program);

-- --------------------------------------------------------------------------
-- instructor_documents: cached index of files a person has uploaded across
--   Jotform (the Document Upload form + CV/photos on the application).
--   drive/jotform URL is the source of truth; this row is a queryable index.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instructor_documents (
  id             SERIAL PRIMARY KEY,
  instructor_id  INTEGER REFERENCES instructors(id) ON DELETE CASCADE,
  email          TEXT,
  doc_type       TEXT,                             -- Passport, CV, Certificate, Photo, ...
  filename       TEXT,
  file_url       TEXT NOT NULL,
  source_form    TEXT,                             -- form title or id it came from
  submission_id  TEXT,
  uploaded_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (submission_id, file_url)
);

CREATE INDEX IF NOT EXISTS instructor_documents_instructor_idx ON instructor_documents (instructor_id);
CREATE INDEX IF NOT EXISTS instructor_documents_email_idx      ON instructor_documents (email);

-- --------------------------------------------------------------------------
-- instructor_onboarding: per-instructor completion of contract, document
--   upload, personal info, and the policy-acknowledgment forms. Completion is
--   inferred from the presence of a matching Jotform submission (by email) on
--   sync, but the `completed` flag can also be toggled manually.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instructor_onboarding (
  id             SERIAL PRIMARY KEY,
  instructor_id  INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  item           TEXT NOT NULL,                    -- canonical key, e.g. 'contract', 'policy_device'
  label          TEXT,                             -- human label for the UI
  completed      BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at   TIMESTAMPTZ,
  submission_id  TEXT,
  UNIQUE (instructor_id, item)
);

CREATE INDEX IF NOT EXISTS instructor_onboarding_instructor_idx ON instructor_onboarding (instructor_id);

-- --------------------------------------------------------------------------
-- Flight budget (per-instructor). Additive + idempotent, so this is safe to
-- run on an existing instructors table.
-- --------------------------------------------------------------------------
ALTER TABLE instructors
  ADD COLUMN IF NOT EXISTS flight_budget          NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS flight_budget_currency TEXT NOT NULL DEFAULT 'USD';

-- Cached Q&A from the Instructor Personal Information form (second profile
-- source), shown in the detail panel for instructors who onboarded without
-- filing an application. Additive + idempotent.
ALTER TABLE instructors
  ADD COLUMN IF NOT EXISTS personal_info_answers JSONB;

-- Additional email addresses per instructor (aliases). The sync matches a
-- Jotform submission to an instructor if its email equals the primary `email`
-- OR any address in `alt_emails` (all stored lower-cased). Lets one profile
-- cover someone who used, say, a personal address on some forms and a work
-- address on others. Additive + idempotent.
ALTER TABLE instructors
  ADD COLUMN IF NOT EXISTS alt_emails TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS instructors_alt_emails_idx ON instructors USING GIN (alt_emails);

-- ==========================================================================
-- Done. The roster view derives weeks_led / programs_led like so:
--
--   SELECT i.*,
--          COALESCE(SUM(a.weeks), 0)               AS weeks_led,
--          COUNT(DISTINCT a.program)               AS programs_led_count,
--          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.program), NULL) AS programs_led
--   FROM instructors i
--   LEFT JOIN instructor_assignments a ON a.instructor_id = i.id
--   GROUP BY i.id;
-- ==========================================================================
