# pd-dashboard additions — Family gallery

Adds the family gallery features to the Field Media card:
- ⭐ approve toggle on every photo tile
- Bulk approve toolbar
- 🔗 Family link button on each trip section header
- Schema additions for approved_for_gallery + gallery_secrets

## Apply

1. Run `MIGRATION-gallery.sql` against Neon SQL Editor (idempotent — safe to re-run)
2. Drop `field-media/index.html` into your repo, replacing the existing one
3. Drop `db/schema.sql` into your repo, replacing the existing one (full updated schema)
4. Commit + push

## Required env vars on pd-dashboard

No new env vars. Just make sure MEDIA_ORIGIN inside field-media/index.html points
at your pd-media URL (it does by default — `https://media.pacificdiscovery.org`).
