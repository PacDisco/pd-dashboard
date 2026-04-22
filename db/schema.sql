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
