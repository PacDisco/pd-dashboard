-- ==========================================================================
-- Flight Programs schema (for the student flight booking portal)
-- Run once against your Netlify DB (Neon Postgres). Idempotent — safe to re-run.
--   From repo root:  netlify db exec < MIGRATION-flight-programs.sql
--   or paste into the Neon SQL editor.
--
-- NOTE: This is a SEPARATE table from the existing `programs` lookup (which is
-- the finance/ops categorization used by `payments`). Travel programs need an
-- airport + arrival/end datetimes, so they live here to avoid coupling.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS flight_programs (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,           -- e.g. "Barcelona — Spring 2026"
  airport_code  TEXT NOT NULL,                  -- program city IATA (flight destination), e.g. "BCN"
  arrival_at    TIMESTAMPTZ NOT NULL,           -- program arrival date/time (basis for outbound date)
  ends_at       TIMESTAMPTZ NOT NULL,           -- program end date/time (basis for return date)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS flight_programs_active_idx
  ON flight_programs (is_active, sort_order, name);

-- Enforce a 3-letter IATA-style code (uppercase). Re-runnable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flight_programs_airport_code_check') THEN
    ALTER TABLE flight_programs DROP CONSTRAINT flight_programs_airport_code_check;
  END IF;
END$$;

ALTER TABLE flight_programs
  ADD CONSTRAINT flight_programs_airport_code_check
  CHECK (airport_code ~ '^[A-Z]{3}$');

-- Reuse the shared updated_at trigger function if present; otherwise create it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flight_programs_set_updated_at ON flight_programs;
CREATE TRIGGER flight_programs_set_updated_at
  BEFORE UPDATE ON flight_programs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Optional seed (safe; skipped if the names already exist).
INSERT INTO flight_programs (name, airport_code, arrival_at, ends_at, sort_order) VALUES
  ('Barcelona — Spring 2026', 'BCN', '2026-01-12 12:00+00', '2026-05-15 12:00+00', 10),
  ('Florence — Spring 2026',  'FLR', '2026-01-19 12:00+00', '2026-05-08 12:00+00', 20)
ON CONFLICT (name) DO NOTHING;
