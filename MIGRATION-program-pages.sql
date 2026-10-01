-- MIGRATION-program-pages.sql
--
-- Program page builder: the content behind www.pacificdiscovery.org/programs/<slug>
-- once a program is published from the Program Pages dashboard.
--
-- Idempotent — safe to re-run in the Neon SQL editor.
--
-- Model
--   program_pages          one row per program page.
--     draft                what editors are working on (autosaved).
--     draft_rev            bumped on every save; the API rejects a save whose
--                          rev is stale (two people editing the same page).
--     published            the copy the public site serves. NULL = not live.
--     published_rev        the draft_rev that was published, so the UI can say
--                          "unpublished changes" when draft_rev > published_rev.
--   program_page_versions  every publish (and every restore) is snapshotted here,
--                          so any earlier live version can be previewed or
--                          restored into the draft.

CREATE TABLE IF NOT EXISTS program_pages (
  slug           TEXT PRIMARY KEY
                 CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  name           TEXT NOT NULL,
  draft          JSONB NOT NULL,
  draft_rev      INTEGER NOT NULL DEFAULT 1,
  published      JSONB,
  published_rev  INTEGER,
  published_at   TIMESTAMPTZ,
  published_by   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT,
  archived_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS program_page_versions (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL REFERENCES program_pages(slug) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('publish', 'restore', 'unpublish')),
  rev         INTEGER,
  data        JSONB NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT
);

CREATE INDEX IF NOT EXISTS program_page_versions_slug_idx
  ON program_page_versions (slug, created_at DESC);
