-- MIGRATION-ue-apply.sql
--
-- The Unearthed Education online application (ue-apply site,
-- apply.unearthededucation.org) and its dashboard (Unearthed Application Form).
-- Separate tables from Pacific Discovery's pd-apply. Idempotent — safe to re-run
-- in the Neon SQL editor.
--
--   ue_apply_forms          the form schema: draft (dashboard) + published (live)
--   ue_apply_form_versions  every publish, for Versions / restore
--   ue_apply_trips          launch links: slug → HubSpot Unearthed Program record,
--                           open/closed, optional deposit override
--   ue_applications         one row per applicant
--   ue_apply_files          uploads (passport, photo …); bytes live in Netlify
--                           Blobs on the ue-apply site, this is the index

CREATE TABLE IF NOT EXISTS ue_apply_forms (
  id             TEXT PRIMARY KEY,                 -- 'ue-application'
  draft          JSONB,
  draft_rev      INTEGER NOT NULL DEFAULT 0,      -- bumped on every save (stale-tab protection)
  published      JSONB,
  published_rev  INTEGER NOT NULL DEFAULT 0,
  published_at   TIMESTAMPTZ,
  published_by   TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS ue_apply_form_versions (
  id          BIGSERIAL PRIMARY KEY,
  form_id     TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'publish',    -- publish | restore | import
  data        JSONB NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS ue_apply_form_versions_idx ON ue_apply_form_versions (form_id, rev DESC);

CREATE TABLE IF NOT EXISTS ue_apply_trips (
  slug            TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  program_id      TEXT NOT NULL,                   -- HubSpot Unearthed Program (2-58156993) record id
  program_name    TEXT,                            -- cached display name
  school          TEXT,                            -- shown to applicants; prefills "What school do you attend?"
  destination     TEXT,                            -- e.g. "Borneo 2027" (used in the deal name)
  open            BOOLEAN NOT NULL DEFAULT true,   -- closed = the link shows "applications are closed"
  deposit         NUMERIC(12, 2),                  -- override; else payment_amount_1 on the program record
  currency        TEXT,                            -- override; else program_currency on the program record
  capacity        INTEGER,                         -- optional: close automatically at this many deposits
  closes_on       DATE,                            -- optional: close automatically after this date
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
CREATE INDEX IF NOT EXISTS ue_apply_trips_program_idx ON ue_apply_trips (program_id);

CREATE TABLE IF NOT EXISTS ue_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          TEXT UNIQUE,                 -- the applicant's resume link (sha256)
  email               TEXT NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  trip_slug           TEXT,
  program_id          TEXT,
  program_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'started'
                      CHECK (status IN ('started', 'applied', 'signed', 'paid', 'imported', 'withdrawn')),
  answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_rev            INTEGER,
  step1_at            TIMESTAMPTZ,
  step2_at            TIMESTAMPTZ,
  waiver              JSONB,                       -- { status: 'sent'|'signed', parentName, relationship, initials, signedAt, ip, parts, signToken hash … }
  waiver_signature    TEXT,                        -- PNG data URL (kept out of `waiver` so lists stay small)
  deposit             JSONB,                       -- { status, amount, currency, method, sessionId, paymentIntent, paidAt }
  hubspot_contact_id  TEXT,
  hubspot_parent_ids  JSONB,
  hubspot_deal_id     TEXT,
  jotform_submission_id TEXT,
  sync                JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-target status + last error
  imported            JSONB,                       -- set by "Add from HubSpot"
  attribution         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ue_applications_email_idx ON ue_applications (lower(email));
CREATE INDEX IF NOT EXISTS ue_applications_trip_idx ON ue_applications (trip_slug, status);
CREATE INDEX IF NOT EXISTS ue_applications_created_idx ON ue_applications (created_at DESC);

CREATE TABLE IF NOT EXISTS ue_apply_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID REFERENCES ue_applications(id) ON DELETE CASCADE,
  field_key   TEXT,
  name        TEXT NOT NULL,
  type        TEXT,
  size        INTEGER,
  blob_key    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ue_apply_files_app_idx ON ue_apply_files (app_id);
