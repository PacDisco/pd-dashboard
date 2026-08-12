# Upcoming Programs — install (3 steps)

New files in this bundle (drop into the repo at the same paths):
  MIGRATION-program-schedule.sql          ← run once against the DB
  netlify/functions/program-schedule.js   ← the API
  program-schedule/index.html             ← the page
  program-schedule/dashboard.json         ← registers it on the landing page

## 1. Create the table (run once)
From the repo root:
    netlify db exec < MIGRATION-program-schedule.sql
…or paste the file into the Neon SQL editor. It's idempotent — safe to re-run.

## 2. Commit & deploy
No manifest editing needed. Your Netlify build command (scripts/build-manifest.js)
scans folders on every deploy, so the new /program-schedule/ folder auto-registers,
gets its /api route, and appears on the Dashboards home page.

## 3. Use it
Open /program-schedule/ (visible to admin, programs, operations roles — change in
dashboard.json's "allowedRoles" if you want other teams to see it).
- Add a program: name, brand, location, start/end dates, participants, notes.
- Filter by brand with the chips; search box filters name/location/notes.
- Upcoming / In progress / Finished badges compute automatically from the dates.
- Uncheck "Active" to archive a program without deleting it (toggle "archived" to see them).

Brands: EDA Group, Unearthed Education, Pacific Discovery, Pure Exploration, Conference.
To change the brand list, edit BRANDS in both program-schedule/index.html and
netlify/functions/program-schedule.js.
