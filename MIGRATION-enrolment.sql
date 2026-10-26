-- MIGRATION-enrolment.sql
--
-- After acceptance: the offer, the family's payment-plan choice, the deposit,
-- the instalment schedule and the saved Stripe payment method (pd-apply's
-- acceptance page, /accept). Idempotent — safe to re-run in the Neon SQL
-- editor. Run after MIGRATION-decisions.sql.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS enrolment JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS applications_deposit_idx ON applications ((enrolment->'deposit'->>'status'));
