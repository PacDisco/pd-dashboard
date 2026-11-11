-- Unearthed applications: a permanent submission ID for every application,
-- so the portals can keep addressing an application by ID after Jotform is gone.
--
-- The portals already know applications by their Jotform submission ID. An
-- application that was copied into Jotform keeps that ID; one that never was
-- gets its own 19-digit ID here (starting with 9, so it can't clash with
-- Jotform's, which start with 5 or 6). Safe to run more than once.

ALTER TABLE ue_applications
  ADD COLUMN IF NOT EXISTS submission_id TEXT
  DEFAULT ('9' || lpad((floor(random() * 1e17))::bigint::text, 18, '0'));

-- Rows that existed before this column: every row got a random ID from the
-- default above; give the ones already copied into Jotform their Jotform ID.
UPDATE ue_applications
   SET submission_id = jotform_submission_id
 WHERE jotform_submission_id IS NOT NULL
   AND submission_id IS DISTINCT FROM jotform_submission_id;

CREATE UNIQUE INDEX IF NOT EXISTS ue_applications_submission_id_key ON ue_applications (submission_id);
CREATE INDEX IF NOT EXISTS ue_applications_jotform_submission_idx ON ue_applications (jotform_submission_id);
