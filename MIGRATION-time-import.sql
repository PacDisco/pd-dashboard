-- ==========================================================================
-- Time Tracking — bulk import.
--
-- Adds the one thing a bulk paste needs that a single manual entry doesn't:
-- a batch id, so an import that went in wrong can be taken back out again in
-- one click instead of deleting forty rows by hand.
--
-- Run AFTER MIGRATION-time-tracking.sql. Idempotent — safe to re-run.
--   From repo root:  netlify db exec < MIGRATION-time-import.sql
--   or paste into the Neon SQL editor.
-- ==========================================================================

-- Every row of one paste shares a batch id. NULL for timer and manual entries,
-- which is what makes "undo import" incapable of touching anything typed by
-- hand: the delete is keyed on the batch, and only imports have one.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS import_batch_id UUID;

-- Undo looks up a whole batch and nothing else, so index exactly that. The
-- partial predicate keeps the index to the imported rows rather than carrying
-- a NULL entry for every tick of every timer.
CREATE INDEX IF NOT EXISTS time_entries_import_batch_idx
  ON time_entries (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- `source` gains a third value: 'timer' | 'manual' | 'import'. The original
-- migration may or may not have constrained the column, and if it did the
-- constraint name is not guaranteed, so find whatever CHECK is on `source`,
-- drop it, and put back one that includes 'import'. A column with no
-- constraint simply gains one.
DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid
   AND a.attnum = ANY (c.conkey)
   AND a.attname = 'source'
  WHERE c.conrelid = 'time_entries'::regclass
    AND c.contype = 'c'
  LIMIT 1;

  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE time_entries DROP CONSTRAINT %I', conname_found);
  END IF;
END$$;

ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_source_check
  CHECK (source IN ('timer', 'manual', 'import'));

-- Duplicate detection during an import preview matches a candidate row against
-- what the contractor already has on that day. Without this the preview does a
-- sequential scan per import; with it, one index hit per row.
CREATE INDEX IF NOT EXISTS time_entries_dupe_probe_idx
  ON time_entries (contractor_id, work_date, started_at, minutes);
