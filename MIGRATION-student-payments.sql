-- MIGRATION-student-payments.sql
--
-- Student payments (Stripe + Wise → HubSpot deal payment_N slots) and the
-- application PDFs attached to HubSpot. Idempotent — safe to re-run in the
-- Neon SQL editor. Needs MIGRATION-apply.sql first (it alters `applications`).
--
--   deal_payments         one row per incoming payment seen on Stripe or Wise.
--                         The ledger: what came in, what it was in USD, which
--                         deal it was logged against and in which slot — or
--                         why it is waiting in the review queue.
--   student_payment_state one row. Run lock + last result per source, so the
--                         scheduled run and "Sync now" can't overlap.
--   applications.pdf_*    which HubSpot note/file holds the application PDF.

CREATE TABLE IF NOT EXISTS deal_payments (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('stripe', 'wise')),
  external_id   TEXT NOT NULL,              -- pi_… / ch_… for Stripe, the Wise referenceNumber
  account       TEXT,                       -- which Stripe key / Wise balance it came from
  received_at   TIMESTAMPTZ NOT NULL,
  amount        NUMERIC(12, 2) NOT NULL,    -- as received, in `currency`
  currency      TEXT NOT NULL,
  amount_usd    NUMERIC(12, 2),             -- what gets logged on the deal
  fx_rate       NUMERIC(14, 8),             -- currency → USD, NULL when already USD
  fee_note      TEXT,                       -- e.g. "card fee 3.5% removed", "Wise fee 6.11 added back"
  payer_name    TEXT,
  payer_email   TEXT,
  reference     TEXT,                       -- what the payer typed / Stripe description
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'logged', 'already_logged', 'review', 'ignored', 'error')),
  reason        TEXT,                       -- why it's in review / ignored / errored
  candidates    JSONB,                      -- deals the matcher considered, for the review queue
  match_method  TEXT,                       -- metadata | reference_id | email | student_name | sender_name | manual
  deal_id       TEXT,
  deal_name     TEXT,
  slot          INTEGER,                    -- payment_N it was written to
  attempts      INTEGER NOT NULL DEFAULT 0,
  resolved_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS deal_payments_status_idx   ON deal_payments (status, received_at);
CREATE INDEX IF NOT EXISTS deal_payments_received_idx ON deal_payments (received_at DESC);
CREATE INDEX IF NOT EXISTS deal_payments_deal_idx     ON deal_payments (deal_id);

CREATE TABLE IF NOT EXISTS student_payment_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  lock_until   TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  last_result  JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO student_payment_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_note_id     TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_file_id     TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_deal_id     TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_attached_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_error       TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS pdf_error_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS applications_pdf_todo_idx ON applications (step2_at) WHERE step2_at IS NOT NULL AND pdf_note_id IS NULL;
