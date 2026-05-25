-- ==========================================================================
-- Invoice tool schema
-- Run once against your Netlify DB (Postgres).
-- From your repo root:
--   netlify db exec < db/schema.sql
-- or paste into the Neon SQL editor.
-- ==========================================================================

-- Programs lookup table (admin-managed dropdown)
CREATE TABLE IF NOT EXISTS programs (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with a few example programs (edit/replace as needed)
INSERT INTO programs (name, sort_order) VALUES
  ('General Operations', 10),
  ('Marketing',          20),
  ('Semester Programs',  30),
  ('Summer Programs',    40),
  ('Facilities',         50)
ON CONFLICT (name) DO NOTHING;

-- Payments table (one row per invoice / scheduled payment)
CREATE TABLE IF NOT EXISTS payments (
  id                 SERIAL PRIMARY KEY,

  -- Core fields
  vendor             TEXT NOT NULL,
  amount             NUMERIC(12, 2) NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  invoice_number     TEXT,
  due_date           DATE NOT NULL,
  program_id         INTEGER REFERENCES programs(id) ON DELETE SET NULL,

  -- File reference (null for manually-entered payments)
  invoice_file_url   TEXT,                  -- Google Drive webViewLink
  invoice_file_id    TEXT,                  -- Google Drive file ID (for later API ops)

  -- Where the row came from
  source             TEXT NOT NULL
                     CHECK (source IN ('upload', 'email', 'manual')),

  -- Workflow flags (the three checkboxes)
  approved_to_pay    BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by        TEXT,                  -- email of approver
  approved_at        TIMESTAMPTZ,

  paid               BOOLEAN NOT NULL DEFAULT FALSE,
  paid_date          DATE,
  paid_by            TEXT,

  -- Reschedule tracking
  rescheduled_from   DATE,                  -- original due_date before a reschedule
  reschedule_reason  TEXT,

  -- Free-form
  notes              TEXT,

  -- Bookkeeping
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS payments_due_date_idx       ON payments (due_date);
CREATE INDEX IF NOT EXISTS payments_paid_idx           ON payments (paid);
CREATE INDEX IF NOT EXISTS payments_approved_idx       ON payments (approved_to_pay);
CREATE INDEX IF NOT EXISTS payments_program_idx        ON payments (program_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ==========================================================================
-- Recurring payments (additive, safe to re-run)
--   recurrence_unit     : 'week' | 'month' | 'year'    (NULL = not recurring)
--   recurrence_interval : every N units (1 for weekly/monthly/annual,
--                         2 for fortnightly, etc.)
--   recurrence_parent_id: the id of the first row in this series.
--                         The "anchor" row has recurrence_parent_id = NULL;
--                         every auto-generated next occurrence points back to
--                         that anchor so we can group a series.
-- ==========================================================================
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS recurrence_unit      TEXT,
  ADD COLUMN IF NOT EXISTS recurrence_interval  INTEGER,
  ADD COLUMN IF NOT EXISTS recurrence_parent_id INTEGER;

-- Drop the constraint first if it exists, so this block stays re-runnable
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_recurrence_unit_check'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT payments_recurrence_unit_check;
  END IF;
END$$;

ALTER TABLE payments
  ADD CONSTRAINT payments_recurrence_unit_check
  CHECK (recurrence_unit IS NULL OR recurrence_unit IN ('week', 'month', 'year'));

CREATE INDEX IF NOT EXISTS payments_recurrence_parent_idx
  ON payments(recurrence_parent_id);

-- ==========================================================================
-- Field media uploader (pd-media app at media.pacificdiscovery.org)
--   - field_trips:   season + program; each trip gets its own Drive subfolder
--   - field_uploads: one row per uploaded photo/video. drive_file_id is the
--                    source of truth; the row itself is just a queryable index.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS field_trips (
  id                 SERIAL PRIMARY KEY,
  season             TEXT NOT NULL,                       -- 'Spring' | 'Summer' | 'Fall' | 'Winter'
  year               INTEGER NOT NULL,
  program            TEXT NOT NULL,                       -- 'Bali', 'Cambodia', etc.
  drive_folder_id    TEXT,                                -- set on first upload
  drive_folder_url   TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(season, year, program)
);

CREATE INDEX IF NOT EXISTS field_trips_active_idx ON field_trips(is_active, year DESC, season);

CREATE TABLE IF NOT EXISTS field_uploads (
  id                  SERIAL PRIMARY KEY,
  trip_id             INTEGER NOT NULL REFERENCES field_trips(id) ON DELETE CASCADE,
  uploader_name       TEXT,                                -- free text, optional
  uploader_device_id  TEXT,                                -- localStorage UUID, used to retry/dedupe
  filename            TEXT NOT NULL,
  mime_type           TEXT,
  size_bytes          BIGINT,
  drive_file_id       TEXT NOT NULL,
  drive_file_url      TEXT NOT NULL,
  thumbnail_url       TEXT,                                -- Drive thumbnailLink, fetched after upload
  tags                TEXT[] NOT NULL DEFAULT '{}',
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('pending', 'uploading', 'complete', 'failed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS field_uploads_trip_idx       ON field_uploads(trip_id);
CREATE INDEX IF NOT EXISTS field_uploads_created_idx    ON field_uploads(created_at DESC);
CREATE INDEX IF NOT EXISTS field_uploads_tags_idx       ON field_uploads USING GIN (tags);

-- ==========================================================================
-- Google Photos integration
--   gphotos_tokens : OAuth tokens, one row per staff user (keyed by email).
--                    Refresh token rotates ~every 7 days; we store the latest.
--   gphotos_albums : per-trip mapping to a Google Photos album that our app
--                    created. share_url is the public family-viewable link.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS gphotos_tokens (
  email          TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  scope          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS gphotos_tokens_updated_at ON gphotos_tokens;
CREATE TRIGGER gphotos_tokens_updated_at
  BEFORE UPDATE ON gphotos_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS gphotos_albums (
  id             SERIAL PRIMARY KEY,
  program        TEXT NOT NULL,                         -- e.g. 'Bali' — one album spans all seasons
  owner_email    TEXT NOT NULL,                         -- whose Google Photos account it lives in
  album_id       TEXT NOT NULL,                         -- Google Photos album ID
  album_title    TEXT,
  product_url    TEXT,                                  -- direct link for the owner
  share_url      TEXT,                                  -- public "anyone with the link" URL
  share_token    TEXT,                                  -- album.shareInfo.shareToken
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(program, owner_email)
);

CREATE INDEX IF NOT EXISTS gphotos_albums_program_idx ON gphotos_albums(program);
