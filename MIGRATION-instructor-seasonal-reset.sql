-- ==========================================================================
-- Instructor onboarding — SEASONAL RESET support.
--
-- Run once, AFTER MIGRATION-instructors.sql and MIGRATION-instructor-checklist.sql:
--   netlify db exec < MIGRATION-instructor-seasonal-reset.sql
-- or paste into the Neon SQL editor. Safe to re-run (idempotent).
--
-- Additive only: no column is dropped and no existing row is deleted.
--
-- WHY THIS EXISTS
--   Onboarding completion is *derived* from Jotform: every dashboard sync and
--   every instructor-portal load re-scans all of a person's Jotform
--   submissions and re-ticks whatever they satisfy. That is exactly right for
--   first-time onboarding, but it makes a "start the season fresh" reset
--   impossible on its own — untick Visa today and last season's Visa upload,
--   still sitting in Jotform, re-ticks it within ~60 seconds.
--
--   The fix is a per-row CUTOFF. When an item is reset we stamp reset_at = now.
--   From then on a Jotform submission only credits that item if it was
--   submitted AFTER the cutoff. So:
--     * a reset sticks (old evidence is ignored), and
--     * a genuinely new upload/submission this season still auto-ticks it
--       (its created_at is newer than the cutoff) — no admin babysitting.
--
--   Nothing about first-time onboarding changes: a row that was never reset
--   has reset_at = NULL, and NULL means "count all evidence", exactly as today.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. The cutoff timestamp.
--
-- NULL  -> never reset; all Jotform evidence counts (unchanged behaviour).
-- set   -> only evidence submitted strictly after this instant credits the row.
--
-- A reset also releases the pin (source -> 'jotform') and clears completed, so
-- the row goes back to automatic detection and re-ticks the moment fresh
-- evidence arrives. That is deliberate: the whole point of the reset is to
-- prompt a *new* upload, then recognise it automatically.
-- --------------------------------------------------------------------------
ALTER TABLE instructor_onboarding
  ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;

-- --------------------------------------------------------------------------
-- 2. Audit log of every reset, and the idempotency guard for the scheduled job.
--
--   run_key   Unique key for one reset event. The seasonal cron uses the
--             season date (e.g. 'season-2026-12-01') so that if Netlify fires
--             the daily check more than once, or the function is retried, the
--             ON CONFLICT DO NOTHING insert makes the second run a no-op.
--             Manual resets from the dashboard use a 'manual-...' key that is
--             always unique, so they always record and never block each other.
--   scope     'all' or 'instructor'.
--   actor     'schedule' or an admin identifier / email.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checklist_reset_log (
  id             SERIAL PRIMARY KEY,
  run_key        TEXT NOT NULL UNIQUE,
  items          TEXT[] NOT NULL DEFAULT '{}',
  scope          TEXT NOT NULL DEFAULT 'all',
  instructor_id  INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  affected_rows  INTEGER NOT NULL DEFAULT 0,
  actor          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS checklist_reset_log_created_idx ON checklist_reset_log (created_at DESC);

-- --------------------------------------------------------------------------
-- 3. Index the cutoff lookups the sync and portal do per row. Small table, but
--    the derive path reads reset_at for every item on every portal load.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS instructor_onboarding_reset_idx
  ON instructor_onboarding (instructor_id, item);

-- ==========================================================================
-- Done.
--
-- After deploying, the scheduled function `seasonal-reset` will clear the
-- Signed Contract and Visa items for every instructor on Dec 1, May 1 and
-- Jul 15. Admins can also reset any item — for one instructor or for all — from
-- the Instructors page. See SEASONAL-RESET.md.
-- ==========================================================================
