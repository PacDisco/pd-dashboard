-- Per-entry brand for the Time Tracker.
--
-- Until now the brand an entry counted towards was implied entirely by its
-- project (time_projects.brand). That works while every project belongs to one
-- brand, and breaks as soon as a project is shared — the contractor picks a
-- project when they tick, never a brand, so shared work all lands under whatever
-- single brand the project happens to carry.
--
-- So the brand becomes a property of the ENTRY, with the project supplying the
-- default:
--
--     NULL  -> this entry counts towards its project's brand, whatever that is
--     set   -> this entry counts towards THIS brand, regardless of the project
--
-- NULL is deliberately the normal state, not a gap to be backfilled. Every row
-- that exists today gets NULL and therefore keeps behaving exactly as it does
-- now — and correcting a mis-branded project still flows through to every past
-- timesheet that used it, which is the property worth keeping. Only a deliberate
-- exception is pinned to the row.
--
-- The application enforces that invariant on write: a brand equal to the
-- project's own brand is stored as NULL rather than as a copy of it. Without
-- that, an entry saved today would silently stop following its project.
--
-- Safe to run more than once.

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS brand text;

COMMENT ON COLUMN time_entries.brand IS
  'Brand override. NULL = inherit from the entry''s project (the normal case). '
  'Set only when the work belongs to a different brand than the project''s own, '
  'which is how a project shared across brands is split.';

-- Reporting reads this column alongside time_projects.brand for every entry on a
-- timesheet, so the planner benefits from finding the non-NULL ones directly.
-- Partial: the overwhelming majority of rows are NULL and are reached by the
-- existing approval_id / contractor_id indexes anyway.
CREATE INDEX IF NOT EXISTS time_entries_brand_idx
  ON time_entries (brand)
  WHERE brand IS NOT NULL;

-- The resolution rule, for reference. The application ships this expression in
-- one place (ENTRY_BRAND_SQL in netlify/functions/time-tracking.js); it is
-- repeated here only so the intent is legible from the schema:
--
--   COALESCE(NULLIF(BTRIM(e.brand), ''), NULLIF(BTRIM(p.brand), ''), '')
--
-- An empty result means "no brand anywhere" and is shown as Unassigned. Blank
-- and whitespace are folded into that same bucket so a project someone saved
-- with a space in the brand field does not become its own phantom brand.
