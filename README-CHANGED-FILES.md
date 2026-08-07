# pd-dashboard — changed files

Copy these over your repo at the same paths. `CHANGES.diff` is a unified diff of
every modified file if you'd rather review before overwriting.

## Run the migration first

`MIGRATION-instructor-checklist.sql` adds **two** columns
(`instructor_onboarding.source` and `instructor_documents.kind`). If you already
ran an earlier version of it, run it again — it's idempotent and only the new
part will apply.

Then open **Instructors** → **⟳ Sync from Jotform** once. That backfills the
Signed Contract item, classifies every already-uploaded document, and records
the form PDFs.

## New

| File | What it is |
|---|---|
| `netlify/functions/_shared/instructor-checklist.js` | The canonical definition: all 14 checklist items, form→item mapping, document classification (dropdown aliases + filename matchers), `submitterEmail`. Both this dashboard and the instructor portal read it, so they can't drift. **Edit the checklist here.** |
| `netlify/functions/instructor-checklist.js` | `GET /api/instructor-checklist?email=` — the read API the portal calls, behind the `INSTRUCTOR_PORTAL_KEY` shared secret. Re-derives from Jotform for that one email before answering, so a form submitted a minute ago already shows. |
| `MIGRATION-instructor-checklist.sql` | `instructor_onboarding.source` (manual pins), `instructor_documents.kind` (upload vs form PDF), label normalisation. Verified idempotent against PostgreSQL 16. |
| `INSTRUCTOR-CHECKLIST.md` | Setup steps, the 14 items, crediting rules, and the `/api/*` auth writeup. |
| `test/instructor-checklist.test.mjs` | 110 cases. `npm test`. |

## Modified

| File | Change |
|---|---|
| `netlify/functions/instructors.js` | Contract form wired in; checklist 7 → 14 items; uploads classified so `doc_type` is a real document type instead of "Additional file upload"; **PDF renders of all 8 signed forms recorded as documents**; document writes batched into one query per form instead of one per file; manual pins respected; failed writes logged loudly. |
| `netlify/functions/jotform-file.mjs` | **Now verifies the caller's Identity token** with GoTrue before streaming; adds the `getSubmissionPDF` retry that Sign-enabled forms need; sends a real filename on download; no longer forwards a stale `content-length`; rendered PDFs revalidate instead of caching for a day. |
| `instructors/index.html` | Documents section groups **Signed forms & policies** / **Uploaded files** and links through the proxy, so nothing asks for a Jotform login. Onboarding drawer shows the 14 items grouped, with pins. |
| `scripts/build-manifest.js` | Emits the `/api/instructor-checklist` rewrite, plus a warning about why an `/api/*` role gate must not go in `_redirects`. |
| `INSTRUCTOR-SYSTEM-README.md` | Onboarding section updated for the 14-item list and pinning. |
| `package.json` | Adds `npm test`. |

## Two security notes

**`jotform-file` was completely unauthenticated.** Anyone who knew the URL could
stream any file in your Jotform account — passports, licences, police checks. It
now verifies the caller's Netlify Identity token against GoTrue (not just
decoding the cookie, which is forgeable) and requires a dashboard role. There's
a test that fires a hand-forged admin cookie at it and asserts a 401.

Because verification calls GoTrue, confirm `URL` is set in the Netlify
environment — Netlify sets it automatically, but if it's missing the proxy fails
closed and documents won't open.

**`/api/*` generally is still ungated** — `/api/instructors?action=list` returns
every instructor profile to anyone. Unchanged by this work, and documented in
`INSTRUCTOR-CHECKLIST.md` including why the fix belongs in `auth-gate.js` and
not in `_redirects` (a wildcard rule there shadows the function mapping and
404s every dashboard data call — I tried it).

## Not included — regenerated at build time

`_redirects`, `dashboards.json` and `dashboards.discovery.json` are written by
`scripts/build-manifest.js` during the Netlify build, so shipping the updated
script regenerates all three.

Note it will also pick up five dashboard folders missing from your committed
manifests (`flight-programs`, `instructors`, `ue-applications`, `ue-flights`,
`unearthed-stripe`) and add the `unearthed` role — your existing build catching
up, not something this change introduced.

## Deploy order

1. `netlify db exec < MIGRATION-instructor-checklist.sql`
2. Set `INSTRUCTOR_PORTAL_KEY` (≥24 chars, `openssl rand -hex 32`) on **both**
   Netlify sites — same value.
3. Deploy this site, then the portal.
4. **⟳ Sync from Jotform** once.
