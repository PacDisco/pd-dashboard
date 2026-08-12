# Upcoming Programs — install (3 steps)

New files (drop into the repo at the same paths):
  MIGRATION-program-schedule.sql          ← run once against the DB
  netlify/functions/program-schedule.js   ← the API
  program-schedule/index.html             ← the page (List + Calendar views)
  program-schedule/dashboard.json         ← registers it on the landing page

## 1. Create the table (run once)
From the repo root:
    netlify db exec < MIGRATION-program-schedule.sql
…or paste the file into the Neon SQL editor. Idempotent — safe to re-run.
(If you ran an earlier version that had a sort_order column, this migration
just drops the old index; the leftover column is harmless and unused.)

## 2. Commit & deploy
No manifest editing needed — scripts/build-manifest.js scans folders on every
deploy, so /program-schedule/ auto-registers, gets its /api route, and appears
on the Dashboards home page.

## 3. Use it
Open /program-schedule/ (visible to admin, programs, operations — change in
dashboard.json "allowedRoles").
- Add a program: name, brand, location, start/end dates, participants, notes.
- LIST view: a date-ordered itinerary, earliest → latest, grouped by month,
  with Upcoming / In progress / Finished badges computed from the dates.
- CALENDAR view: month grid with each program drawn as a brand-coloured bar
  across its dates; click any program to jump to its editor. Prev / Today / Next
  to move between months.
- Filter by brand with the chips; search filters name/location/notes.
- "finished" shows past programs; "archived" shows ones you've de-activated
  (uncheck "Active" on a program to archive without deleting).

Brands: EDA Group, Unearthed Education, Pacific Discovery, Pure Exploration,
Conference. To change them, edit BRANDS in BOTH program-schedule/index.html and
netlify/functions/program-schedule.js.
