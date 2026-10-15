-- ==========================================================================
-- Time Tracking — personal projects.
--
-- Anyone can now add a project for their own work. Those are PERSONAL: they
-- carry the creator's email in owner_email, show up only in that person's
-- picker (and in reviewers'/admins' reports), and only that person or an admin
-- can change them. owner_email NULL is a team project, exactly as before — so
-- every existing project stays a team project.
--
-- Run AFTER MIGRATION-time-tracking.sql. Idempotent — safe to re-run.
--   From repo root:  netlify db exec < MIGRATION-time-projects-owner.sql
--   or paste into the Neon SQL editor.
-- ==========================================================================

ALTER TABLE time_projects ADD COLUMN IF NOT EXISTS owner_email TEXT;

-- Project names were unique across the whole table. Two people may now each
-- have their own "Admin" project, so uniqueness becomes per owner (team
-- projects share one namespace). The old rule may exist as a constraint or as
-- a plain unique index depending on how the first migration was written, so
-- drop whichever is there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'time_projects_name_uniq'
                AND conrelid = 'time_projects'::regclass) THEN
    ALTER TABLE time_projects DROP CONSTRAINT time_projects_name_uniq;
  END IF;
END $$;
DROP INDEX IF EXISTS time_projects_name_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS time_projects_name_owner_uniq
  ON time_projects (LOWER(name), COALESCE(LOWER(owner_email), ''));

CREATE INDEX IF NOT EXISTS time_projects_owner_idx
  ON time_projects (LOWER(owner_email))
  WHERE owner_email IS NOT NULL;
