-- MIGRATION-marketing-spend.sql
--
-- Backs the "Marketing Performance" dashboard (/marketing-performance/).
--
-- Why this table exists at all: every other number on that dashboard is read
-- live from HubSpot or Jotform, which is the house rule — Neon holds only
-- state the business types in, never a cache of an upstream. Ad spend is the
-- one input with no API behind it. Google Ads and Meta are not connected to
-- this stack, so somebody enters the monthly figure by hand. Today that
-- happens in a Google Sheet behind an Apps Script (see /lead-data-sheet/);
-- this table brings it inside the app so cost-per-outcome can be joined to
-- the HubSpot funnel without a second system in the loop.
--
-- Grain: one row per (month, channel). Channel strings MUST match the labels
-- emitted by netlify/functions/sales-funnel-data.mjs — HUBSPOT_SOURCE_LABELS
-- and CHANNEL_FIELD_TO_LABEL — or the join on the dashboard silently drops to
-- zero. The canonical set:
--   Organic Search · Paid Search · Paid Social · Organic Social ·
--   Email Marketing · Direct Traffic · Referrals · Other Campaigns ·
--   Offline Sources · AI Referrals
--
-- Currency: spend is stored in the currency it was billed in, plus the NZD
-- amount actually used for reporting. Meta bills Pacific Discovery in USD and
-- Google Ads in NZD, so a single-currency column would either lose the source
-- figure or bake in an invisible FX assumption. fx_to_nzd records the rate
-- used, so a historical row can always be explained.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS marketing_spend (
  id            BIGSERIAL PRIMARY KEY,

  -- First day of the month the spend belongs to, e.g. 2026-06-01.
  -- Stored as a DATE rather than a 'YYYY-MM' string so ordering and range
  -- filters are index-friendly; the API speaks 'YYYY-MM' at its edges.
  month         DATE NOT NULL,

  channel       TEXT NOT NULL,

  -- What the platform billed, in its own currency.
  amount        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency      TEXT           NOT NULL DEFAULT 'NZD',

  -- Rate applied to reach amount_nzd. 1 when currency is already NZD.
  fx_to_nzd     NUMERIC(12, 6) NOT NULL DEFAULT 1,

  -- The reporting figure. Written by the API as amount * fx_to_nzd so the
  -- dashboard never has to do currency maths at read time.
  amount_nzd    NUMERIC(12, 2) NOT NULL DEFAULT 0,

  note          TEXT,

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT
);

-- One figure per channel per month. The API upserts on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_spend_month_channel_idx
  ON marketing_spend (month, channel);

-- The dashboard always reads a contiguous month range.
CREATE INDEX IF NOT EXISTS marketing_spend_month_idx
  ON marketing_spend (month);

-- Backfill note (not run automatically): June and July 2026 were audited
-- directly from the ad platforms on 25 Aug 2026 and can be seeded with
--
--   INSERT INTO marketing_spend (month, channel, amount, currency, fx_to_nzd, amount_nzd, note)
--   VALUES
--     ('2026-06-01', 'Paid Search', 1570.44, 'NZD', 1,     1570.44, 'Google Ads acct 418-542-0382'),
--     ('2026-07-01', 'Paid Search', 1574.16, 'NZD', 1,     1574.16, 'Google Ads acct 418-542-0382'),
--     ('2026-06-01', 'Paid Social',  238.74, 'USD', 1.75,   417.80, 'Meta ad acct 37358870'),
--     ('2026-07-01', 'Paid Social',  242.96, 'USD', 1.75,   425.18, 'Meta ad acct 37358870')
--   ON CONFLICT (month, channel) DO NOTHING;
--
-- The 1.75 FX rate is an assumption, not a looked-up rate — replace it with
-- whatever rate the accounts use before treating those two rows as final.
