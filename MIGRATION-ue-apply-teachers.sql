-- Unearthed applications: teachers.
-- A second application form (apply.unearthededucation.org/<trip>/teacher),
-- stored alongside the student applications. Safe to run more than once.

ALTER TABLE ue_applications
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'student';

DO $$ BEGIN
  ALTER TABLE ue_applications ADD CONSTRAINT ue_applications_kind_check CHECK (kind IN ('student', 'teacher'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Teacher form only: the role they applied for — 'Teacher' (/<trip>/teacher)
-- or 'Trip Leader' (/<trip>/leader). Same form for both.
ALTER TABLE ue_applications ADD COLUMN IF NOT EXISTS role TEXT;

-- Staff approval of a teacher: { at, by, programId, label }. Approving is what
-- gives them the "Teacher" label on the trip — and with it the leader portal.
ALTER TABLE ue_applications ADD COLUMN IF NOT EXISTS approval JSONB;

CREATE INDEX IF NOT EXISTS ue_applications_kind_idx ON ue_applications (kind, trip_slug);

-- The teacher form lives in ue_apply_forms under id 'ue-teacher-application'
-- (created from the dashboard: Unearthed Application Form → Teacher form).
