-- MIGRATION-lead-alerts.sql
--
-- Lead Alerts phone app (/lead-alerts/). Idempotent — safe to re-run in the
-- Neon SQL editor. OPTIONAL: the functions create these tables themselves on
-- first use; this file is here so the schema is written down. See LEAD-ALERTS.md.

CREATE TABLE IF NOT EXISTS lead_alert_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  email         TEXT,
  name          TEXT,
  phone         TEXT,
  contact_id    TEXT,
  detail        TEXT,
  source        TEXT,
  ref_id        TEXT,
  pushed_at     TIMESTAMPTZ,
  reminded_at   TIMESTAMPTZ,
  handled_at    TIMESTAMPTZ,
  handled_by    TEXT,
  handled_how   TEXT
);

CREATE INDEX IF NOT EXISTS lead_alert_events_detected_idx ON lead_alert_events (detected_at DESC);

CREATE INDEX IF NOT EXISTS lead_alert_events_email_idx ON lead_alert_events (lower(email), occurred_at);

CREATE TABLE IF NOT EXISTS lead_alert_subs (
  endpoint      TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  roles         JSONB NOT NULL DEFAULT '[]'::jsonb,
  subscription  JSONB NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at    TIMESTAMPTZ,
  fail_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lead_alert_seen (
  email    TEXT PRIMARY KEY,
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_alert_prefs (
  email          TEXT PRIMARY KEY,
  tz             TEXT,
  schedule       JSONB,
  online         BOOLEAN NOT NULL DEFAULT true,
  online_since   TIMESTAMPTZ,
  offline_since  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lead_alert_prefs ADD COLUMN IF NOT EXISTS aircall_email TEXT;

ALTER TABLE lead_alert_prefs ADD COLUMN IF NOT EXISTS aircall_user_id TEXT;

CREATE TABLE IF NOT EXISTS lead_alert_reminders (
  event_id  TEXT NOT NULL,
  email     TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, email)
);

CREATE TABLE IF NOT EXISTS lead_alert_state (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
