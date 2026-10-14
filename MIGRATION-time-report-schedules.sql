-- ==========================================================================
-- Time Tracking — scheduled report emails.
--
-- One row per "email me this report every week / every other week". The
-- report's own settings (columns, grouping, filters) live in `options` as the
-- same JSON the Export report dialog sends, so a schedule is exactly a saved
-- export plus a cadence and a list of addresses.
--
-- Run AFTER MIGRATION-time-tracking.sql. Idempotent — safe to re-run.
--   From repo root:  netlify db exec < MIGRATION-time-report-schedules.sql
--   or paste into the Neon SQL editor.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS time_report_schedules (
  id                 SERIAL PRIMARY KEY,
  -- Who set it up. A personal ('self') report is always about, and only ever
  -- sent to, this person.
  owner_email        TEXT NOT NULL,
  owner_name         TEXT,
  -- Snapshot of whether the owner may see the team, refreshed every time they
  -- open the tracker. A team report stops sending the day it goes false.
  owner_can_review   BOOLEAN NOT NULL DEFAULT FALSE,
  scope              TEXT NOT NULL CHECK (scope IN ('self', 'team')),
  name               TEXT,
  frequency          TEXT NOT NULL CHECK (frequency IN ('weekly', 'fortnightly')),
  formats            TEXT[] NOT NULL DEFAULT '{csv}',
  recipients         TEXT[] NOT NULL DEFAULT '{}',
  options            JSONB NOT NULL DEFAULT '{}'::jsonb,
  timezone           TEXT NOT NULL DEFAULT 'Pacific/Auckland',
  -- Always a Monday. The report sent that day covers the week (or two) that
  -- ended the Sunday before.
  next_send_on       DATE NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at       TIMESTAMPTZ,
  last_period_start  DATE,
  last_period_end    DATE,
  last_error         TEXT,
  last_error_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The daily run asks one question: which active schedules are due?
CREATE INDEX IF NOT EXISTS time_report_schedules_due_idx
  ON time_report_schedules (next_send_on)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS time_report_schedules_owner_idx
  ON time_report_schedules (LOWER(owner_email));
