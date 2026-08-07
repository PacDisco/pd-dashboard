# pd-dashboard — changed files

Copy these over your repo at the same paths. `CHANGES.diff` is a unified diff of
every modified file if you'd rather review before overwriting.

## New

| File | What it is |
|---|---|
| `netlify/functions/_shared/instructor-checklist.js` | **The canonical definition.** All 14 checklist items, the Jotform form→item map, document classification (dropdown aliases + filename matchers), and `submitterEmail`. Both this dashboard and the instructor portal read from here, so they can't drift. Edit the checklist HERE. |
| `netlify/functions/instructor-checklist.js` | `GET /api/instructor-checklist?email=` — the read API the portal calls, guarded by the `INSTRUCTOR_PORTAL_KEY` shared secret. Re-derives from Jotform for that one email before answering and writes back anything new. |
| `MIGRATION-instructor-checklist.sql` | Adds `instructor_onboarding.source`, backfills hand-un-ticked rows as `manual`, normalises labels. Idempotent — verified by running it three times against PostgreSQL 16. |
| `INSTRUCTOR-CHECKLIST.md` | Setup steps, the 14 items, crediting rules, and the `/api/*` auth writeup. |
| `test/instructor-checklist.test.mjs` | 83 cases. `npm test`. |

## Modified

| File | Change |
|---|---|
| `netlify/functions/instructors.js` | Contract form added to `FORMS`; `ONBOARDING_ITEMS` now comes from `_shared` (7 → 14 items); upload files are classified so `doc_type` is a real document type instead of "Additional file upload"; new `markOnboarding` respects manual pins and no-ops when nothing changed; `handleSetOnboarding` records `source`; `onboarding_done` counts only canonical items. |
| `instructors/index.html` | Drawer groups the checklist into Forms & policies / Documents, shows an `x of 14` count, and marks hand-set rows **pinned**. |
| `scripts/build-manifest.js` | Emits the `/api/instructor-checklist` rewrite, plus a comment explaining why a `/api/*` role gate must NOT be added here. |
| `INSTRUCTOR-SYSTEM-README.md` | Onboarding section updated for the 14-item list and pinning. |
| `package.json` | Adds `npm test`. |

## Not included — regenerated at build time

`_redirects`, `dashboards.json` and `dashboards.discovery.json` are written by
`scripts/build-manifest.js`, which runs as your Netlify build command. Deploying
the updated `build-manifest.js` regenerates all three.

Worth knowing: when I ran it locally it also picked up five dashboard folders
that are in the repo but missing from your committed manifests
(`flight-programs`, `instructors`, `ue-applications`, `ue-flights`,
`unearthed-stripe`) and added the `unearthed` role everywhere. That's your
existing build catching up, not something this change introduced — but it means
the next deploy will alter those three files more than you might expect.

## Before deploying

1. `netlify db exec < MIGRATION-instructor-checklist.sql`
2. Set `INSTRUCTOR_PORTAL_KEY` (≥24 chars, `openssl rand -hex 32`) on **both**
   Netlify sites — same value.
3. Deploy this site first, then the portal.
4. Open **Instructors** → **⟳ Sync from Jotform** once, to backfill the Signed
   Contract item and classify existing uploads.
