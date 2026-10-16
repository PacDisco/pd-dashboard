-- MIGRATION-referral.sql
--
-- Referral form on apply.pacificdiscovery.org/refer (pd-apply). Idempotent —
-- safe to re-run in the Neon SQL editor. Run AFTER MIGRATION-apply.sql.
--
-- The form definition lives in apply_forms as the row 'pd-referral' (edited
-- in the dashboard: Apply Form → Referral form). Each referral is one row
-- here — one referrer + one referred person. Someone referring three friends
-- makes three rows (the thank-you page offers "Refer someone else").

CREATE TABLE IF NOT EXISTS referrals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_type          TEXT,
  referrer_email         TEXT NOT NULL,
  referrer_first_name    TEXT,
  referrer_last_name     TEXT,
  referred_email         TEXT NOT NULL,
  referred_first_name    TEXT,
  referred_last_name     TEXT,
  answers                JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_rev               INTEGER,
  attribution            JSONB,
  referrer_contact_id    TEXT,
  referred_contact_id    TEXT,
  referred_existed       BOOLEAN,          -- the referred email was already in HubSpot
  sync                   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { referrer, referred, association, form, email }: { ok, error?, at }
  ip                     TEXT,
  user_agent             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_created_idx  ON referrals (created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (lower(referrer_email));
CREATE INDEX IF NOT EXISTS referrals_referred_idx ON referrals (lower(referred_email));
CREATE INDEX IF NOT EXISTS referrals_ip_idx       ON referrals (ip, created_at);
