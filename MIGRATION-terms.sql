-- MIGRATION-terms.sql
--
-- Program Terms & Conditions, edited in the Apply Form dashboard (Terms tab)
-- and served by pd-apply to the website page, the applicant emails and the
-- acceptance page. Idempotent — safe to re-run in the Neon SQL editor.
--
--   apply_terms           one row per document ('program-terms'): the draft
--                         editors are working on.
--   apply_terms_versions  every publish. The highest version is live. Old
--                         versions are kept forever: each payment records the
--                         version the family was shown, so what they agreed to
--                         can always be produced.

CREATE TABLE IF NOT EXISTS apply_terms (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Program Terms & Conditions',
  draft       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS apply_terms_versions (
  doc_id        TEXT NOT NULL REFERENCES apply_terms(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  note          TEXT,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by  TEXT,
  PRIMARY KEY (doc_id, version)
);

INSERT INTO apply_terms (id) VALUES ('program-terms') ON CONFLICT (id) DO NOTHING;
