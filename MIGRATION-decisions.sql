-- MIGRATION-decisions.sql
--
-- Admissions decisions (dashboard → Applications → Accept / Decline), carried
-- out by pd-apply (Stripe refund, family email, HubSpot). Idempotent — safe to
-- re-run in the Neon SQL editor. Run after MIGRATION-apply.sql.
--
--   applications.decision  { outcome: "accepted" | "declined", at, by, message,
--                            holdUntil (accepted), refund (declined),
--                            email, hubspot, history: [earlier decisions] }

ALTER TABLE applications ADD COLUMN IF NOT EXISTS decision JSONB;
CREATE INDEX IF NOT EXISTS applications_decision_idx ON applications ((decision->>'outcome'));
