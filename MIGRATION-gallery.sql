-- Family gallery additions — safe to re-run
ALTER TABLE field_uploads
  ADD COLUMN IF NOT EXISTS approved_for_gallery BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS field_uploads_approved_idx
  ON field_uploads(trip_id, approved_for_gallery)
  WHERE approved_for_gallery = TRUE;
CREATE TABLE IF NOT EXISTS gallery_secrets (
  trip_id     INTEGER PRIMARY KEY REFERENCES field_trips(id) ON DELETE CASCADE,
  secret      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
