-- MIGRATION-student-payments-brands.sql
--
-- Unearthed Education payments in the same ledger as Pacific Discovery's.
-- Run after MIGRATION-student-payments.sql. Idempotent — safe to re-run in the
-- Neon SQL editor. Existing rows become brand 'pd'; nothing else changes for them.
--
--   brand       'pd' | 'ue' — whose Stripe / Wise account the money came into.
--   status      + 'watch': a brand in watch mode matched this payment and
--               recorded what it would do (deal, slot, stage move) without
--               writing to HubSpot. Processed for real when the brand goes live.
--   stage_move  the deal stage change the sync made (or would make), e.g.
--               "Application Complete → Deposit Paid (paid $1,750, deposit $1,750)".
--   unique key  (brand, source, external_id) — two Wise accounts can't collide.

ALTER TABLE deal_payments ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT 'pd';
ALTER TABLE deal_payments ADD COLUMN IF NOT EXISTS stage_move TEXT;

ALTER TABLE deal_payments DROP CONSTRAINT IF EXISTS deal_payments_status_check;
ALTER TABLE deal_payments ADD CONSTRAINT deal_payments_status_check
  CHECK (status IN ('pending', 'logged', 'already_logged', 'review', 'ignored', 'error', 'watch'));

ALTER TABLE deal_payments DROP CONSTRAINT IF EXISTS deal_payments_brand_check;
ALTER TABLE deal_payments ADD CONSTRAINT deal_payments_brand_check CHECK (brand IN ('pd', 'ue'));

ALTER TABLE deal_payments DROP CONSTRAINT IF EXISTS deal_payments_source_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS deal_payments_brand_source_external_key ON deal_payments (brand, source, external_id);
CREATE INDEX IF NOT EXISTS deal_payments_brand_status_idx ON deal_payments (brand, status, received_at);
