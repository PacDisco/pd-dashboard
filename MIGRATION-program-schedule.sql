-- ==========================================================================
-- Program Schedule — "Upcoming Programs" tracker for the group.
-- A lightweight, at-a-glance itinerary of programs across all brands: program
-- name, brand, location, start/end dates, participant count, and notes.
-- Run once against your Netlify DB (Neon Postgres). Idempotent — safe to re-run.
--   From repo root:  netlify db exec < MIGRATION-program-schedule.sql
--   or paste into the Neon SQL editor.
--
-- NOTE: This is intentionally SEPARATE from `flight_programs` (which drives the
-- student flight-booking portal and needs airports/times). This table is a
-- simple internal planning view, so dates are stored as plain DATE values —
-- no timezone handling required. Programs are always ordered by date.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS program_schedule (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                  -- e.g. "South America Semester — Fall 2026"
  brand         TEXT NOT NULL,                  -- e.g. "Pacific Discovery"
  location      TEXT,                           -- optional country / city
  start_date    DATE NOT NULL,                  -- program start
  end_date      DATE,                           -- program end (optional)
  participants  INTEGER,                        -- optional headcount
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,  -- uncheck to archive without deleting
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bring columns up to date if an older version of the table already exists.
ALTER TABLE program_schedule ADD COLUMN IF NOT EXISTS location     TEXT;
ALTER TABLE program_schedule ADD COLUMN IF NOT EXISTS participants INTEGER;
ALTER TABLE program_schedule ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT TRUE;

-- Programs are ordered purely by date (earliest → latest), so index for that.
DROP INDEX IF EXISTS program_schedule_order_idx;
CREATE INDEX IF NOT EXISTS program_schedule_date_idx
  ON program_schedule (is_active, start_date, name);

-- Guard against nonsensical ranges (end before start). Re-runnable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_schedule_date_range_check') THEN
    ALTER TABLE program_schedule DROP CONSTRAINT program_schedule_date_range_check;
  END IF;
END$$;

ALTER TABLE program_schedule
  ADD CONSTRAINT program_schedule_date_range_check
  CHECK (end_date IS NULL OR end_date >= start_date);

-- Participants can't be negative. Re-runnable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_schedule_participants_check') THEN
    ALTER TABLE program_schedule DROP CONSTRAINT program_schedule_participants_check;
  END IF;
END$$;

ALTER TABLE program_schedule
  ADD CONSTRAINT program_schedule_participants_check
  CHECK (participants IS NULL OR participants >= 0);

-- Reuse the shared updated_at trigger function if present; otherwise create it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS program_schedule_set_updated_at ON program_schedule;
CREATE TRIGGER program_schedule_set_updated_at
  BEFORE UPDATE ON program_schedule
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
