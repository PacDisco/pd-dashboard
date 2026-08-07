-- ==========================================================================
-- Instructor onboarding checklist — unification with the instructor portal.
--
-- Run once, AFTER MIGRATION-instructors.sql:
--   netlify db exec < MIGRATION-instructor-checklist.sql
-- or paste into the Neon SQL editor. Safe to re-run (idempotent).
--
-- Additive only: no column is dropped and no existing row is deleted.
--
-- WHAT THIS ENABLES
--   The instructor portal's DOCUMENT CHECKLIST used to read a HubSpot contact
--   property that nothing ever wrote. It now reads instructor_onboarding
--   through /api/instructor-checklist. To serve both audiences from one list,
--   the checklist grew from 7 items to 14: the existing Personal Information +
--   6 policy forms, PLUS the Signed Contract form and the 6 documents that
--   arrive through the Instructor Document Upload Form.
--
--   Existing item keys are unchanged, so nothing needs re-keying. The new keys
--   are: contract, doc_passport, doc_drivers_license, doc_wfr,
--   doc_police_check, doc_photos, doc_visa. They are created on demand by the
--   next sync / portal load — no backfill needed here.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. Provenance on each checklist row.
--
-- 'jotform' — ticked automatically because a matching submission was found.
-- 'manual'  — an admin set this by hand in the dashboard. PINNED: the sync
--             will not change it. This is what makes un-ticking stick, e.g. a
--             police check that came back unsatisfactory or an expired WFR
--             cert. Before this column, the next sync silently re-ticked it.
--
-- Backfill: the old sync could only ever write completed = TRUE, so any row
-- sitting at completed = FALSE must have been un-ticked by hand in the
-- dashboard. Those are exactly the deliberate overrides the pin is meant to
-- protect — a rejected police check, an expired WFR cert — so they are
-- backfilled as 'manual'. Defaulting the whole table to 'jotform' would let
-- the very next sync silently re-tick every one of them, which is the failure
-- this column exists to prevent.
-- --------------------------------------------------------------------------
ALTER TABLE instructor_onboarding
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'jotform';

-- Runs only on the first execution: once rows are marked manual, re-running is
-- a no-op because the sync never sets completed = FALSE.
UPDATE instructor_onboarding
   SET source = 'manual'
 WHERE completed = FALSE
   AND source = 'jotform';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'instructor_onboarding_source_chk'
  ) THEN
    ALTER TABLE instructor_onboarding
      ADD CONSTRAINT instructor_onboarding_source_chk
      CHECK (source IN ('jotform', 'manual'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. Re-label rows to the canonical labels, so the dashboard and the portal
--    always show a document by the same name. Only touches the seven items
--    that already existed; new items arrive correctly labelled.
-- --------------------------------------------------------------------------
UPDATE instructor_onboarding SET label = 'Personal Information'       WHERE item = 'personal_info'       AND label IS DISTINCT FROM 'Personal Information';
UPDATE instructor_onboarding SET label = 'Device Policy'              WHERE item = 'policy_device'       AND label IS DISTINCT FROM 'Device Policy';
UPDATE instructor_onboarding SET label = 'Drug & Alcohol Policy'      WHERE item = 'policy_drug_alcohol' AND label IS DISTINCT FROM 'Drug & Alcohol Policy';
UPDATE instructor_onboarding SET label = 'Flight Policy'              WHERE item = 'policy_flight'       AND label IS DISTINCT FROM 'Flight Policy';
UPDATE instructor_onboarding SET label = 'Money & Credit Card Policy' WHERE item = 'policy_money'        AND label IS DISTINCT FROM 'Money & Credit Card Policy';
UPDATE instructor_onboarding SET label = 'First Aid Kit Policy'       WHERE item = 'policy_first_aid'    AND label IS DISTINCT FROM 'First Aid Kit Policy';
UPDATE instructor_onboarding SET label = 'Van Use Policy'             WHERE item = 'policy_van'          AND label IS DISTINCT FROM 'Van Use Policy';

-- --------------------------------------------------------------------------
-- 3. Index for the portal's lookup path: it resolves an instructor by primary
--    email OR any alias, on every checklist load.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS instructor_onboarding_item_idx
  ON instructor_onboarding (item);

-- ==========================================================================
-- Done.
--
-- After deploying, set INSTRUCTOR_PORTAL_KEY to the SAME long random value on
-- both Netlify sites (dashboard + instructor portal):
--     openssl rand -hex 32
--
-- Then open Instructors and click "⟳ Sync from Jotform" once. That backfills
-- the Signed Contract item and classifies every already-uploaded document into
-- its checklist item.
-- ==========================================================================
