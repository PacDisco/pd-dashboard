# Instructor Management System — setup & handoff

A new dashboard module (`/instructors/`) that gives you one profile per instructor,
keyed by email, tying together everything that already lives in Jotform plus the
admin layer Jotform can't do (lifecycle status, program history, onboarding).

## What's included

| File | What it is |
|---|---|
| `instructors/index.html` | The dashboard page (roster, filters, detail drawer). |
| `instructors/dashboard.json` | Tile metadata — category *Programs*, roles `admin, programs, operations`. |
| `netlify/functions/instructors.js` | The API (`/api/instructors`): CRUD + Jotform sync. |
| `MIGRATION-instructors.sql` | Four Postgres tables. Run once. |

Drop these into your `pd-dashboard` repo in the same paths, commit, and let Netlify
build. The build step (`scripts/build-manifest.js`) auto-registers the folder — no
manifest edits needed. It already appears in `dashboards.json` / `_redirects` in this
package.

## One-time setup

1. **Run the migration** against your Neon DB:
   ```
   netlify db exec < MIGRATION-instructors.sql
   ```
   (or paste it into the Neon SQL editor). Safe to re-run.

2. **Confirm env vars** already exist on the site (they do — other tools use them):
   `NETLIFY_DATABASE_URL` and `JOTFORM_API_KEY`.

3. **Deploy**, open **Instructors**, and click **⟳ Sync from Jotform**. That pulls the
   PD Program Instructor Application (221 submissions), the Document Upload form, and
   the contract/policy forms, and builds a profile per applicant email.

## How the data comes together

- **Application, uploads, profile fields** (gender, location, nationality, languages,
  regions, WFR, driver's licence, prior-participant) — pulled from Jotform on **Sync**,
  matched to a profile by **email**. Re-syncing refreshes the cached application and
  documents but **never overwrites a field you've edited by hand** (it only fills blanks).
- **Status** (`current` / `potential` / `new_applicant` / `blacklisted`) — set in the app.
  New synced applicants land as *new applicant*.
- **Program-leading history** (the source of *weeks led* and *previous programs led*) —
  entered manually in each instructor's detail drawer. *Weeks led* and *programs led*
  on the roster are summed from these rows automatically.
- **Onboarding** — a 14-item checklist: the Signed Contract, Personal Information and
  6 policy forms, plus the 6 documents that arrive through the upload form (Passport,
  Drivers License, WFR Certificate, Police/Background Check, 2 Photos, Visa). A tick
  appears automatically when matching evidence is found on sync, and you can toggle
  items by hand — a hand-toggled item shows **pinned** and the sync leaves it alone
  from then on. **This same list is what instructors see in their portal.**
  See `INSTRUCTOR-CHECKLIST.md` for the rules and the one-time setup.

## Filters on the roster

Status, search (name/email), gender, location, minimum weeks led, program led,
qualification, language, region of experience, returning-instructor, and
"missing paperwork" (onboarding incomplete). All filtering is instant/client-side.

## Jotform forms wired in (edit `FORMS` in `instructors.js` to change)

- Application: `241888714639876`
- Document Upload: `261607538438868`
- Personal Info: `261748248196873`
- Policies: Device `261722834653056`, Drug & Alcohol `261727420881863`,
  Flight `261727594157871`, Money `261726712606861`, First Aid `261727467730867`,
  Van Use `261756536759069`

## Notes / possible next steps

- Field mapping from the application uses the question **labels** (e.g. "Gender",
  "Nationality on Passport"). If you rename those questions in Jotform, update the
  matching hints in `handleSync()`.
- The "Join Our Instructor Pool!" recruitment form (`241206212530035`) isn't wired in
  yet — say the word and I'll fold it in as a lightweight applicant source.
- `rating` is a manual field now; it could later be auto-derived from the instructor
  feedback forms and field reports.
