# Time Tracker — reports & scheduled emails

## What people get

**Everyone** (My week tab → **📄 Export report**)
- Their own time only, as **CSV or PDF**. The server pins the report to the signed-in person; nothing in the request can widen it.
- Period presets (week on screen, this/last week, last 2 weeks, this/last month) or custom dates.
- Filter by project, brand and approval status; group by day, week, project or brand; every entry or totals only; pick columns; optionally include their own rate and amount.
- **Email this automatically** — every week or every other week, to their own address only.

**Reviewers and admins** (Team tab → **📄 Export report**)
- Everything above, across the team, plus a **People** picker and a "by person" table (exact hours, billable hours, and — if ticked — rate and amount).
- Scheduled team reports can go to up to 10 addresses (e.g. accounts@).
- Admins see everyone's schedules (so a report left running by someone who's left can be paused or deleted).

**Every report leads with "Time by project"** — each project's code, brand, entries, hours and % of the period. Team reports add each project's owner and head-count, plus a "Projects by person" breakdown. The email body shows the same project table. The chosen grouping (day, week, brand, person) still gets its own summary underneath.

## Personal projects

Everyone now has the **Projects** tab.
- Anyone can add a project. A non-admin's project is **personal**: it appears only in their own timer/entry pickers (under "My projects") and only they — or an admin — can rename, archive or delete it. Nobody else can log time to it.
- Team projects (made by an admin) are read-only to everyone else, as before.
- Reviewers and admins see everyone's personal projects, labelled with the owner, so reports and filters cover them.
- An admin can click **Make team project** to open a personal project up to everyone; existing time stays put.
- Names are unique per list: a personal project can't copy a team project's name or one of the owner's own, but two people can each have their own "Research".
- Requires `MIGRATION-time-projects-owner.sql`. Until it's run everything still works; adding a personal project just asks for the migration.

The quick **⭳ CSV** button is unchanged — it's still the Bulk-import-compatible layout of the week on screen.

## How the emails work

- Sent **Monday mornings** (daily run at 19:00 UTC = 8am NZDT / 7am NZST; due-ness is judged in each schedule's own timezone).
- Weekly covers the Mon–Sun just finished; every-other-week covers the two Mon–Sun weeks just finished.
- Body has the headline numbers and summary table; the CSV and/or PDF are attached.
- **Send now** on any schedule emails the last whole period immediately (doesn't move Monday's send).
- A failed send stays due and retries the next morning; the error shows in the list. After two weeks of failures the schedule pauses itself.
- A team schedule stops sending if its owner loses the admin/timesheet-reviewer role (checked each time they open the tracker) or is deactivated.

**Mailbox:** reuses the Gmail mailbox already connected for popup lead notifications (Popups dashboard → Connect Gmail). No new provider or env vars. If none is connected, schedules save but the dialog and list warn that they can't send.

## Rounding

Same rule as the rest of the tracker: entries are exact; billable = each person's period total rounded to the nearest quarter hour once. A team's billable total is the sum of those per-person figures (so it matches what gets approved), not a rounding of the team's raw total.

## Deploy

1. Run `MIGRATION-time-projects-owner.sql` and `MIGRATION-time-report-schedules.sql` (Neon SQL editor or `netlify db exec < MIGRATION-time-report-schedules.sql`). Idempotent.
2. Deploy. `npm install` picks up `jspdf` + `jspdf-autotable` (same versions as the cash-forecast vendored copies), used server-side for PDFs.
3. Make sure Gmail is connected in the Popups dashboard.

## Files

| File | |
|---|---|
| `netlify/functions/_shared/time-report.js` | Report engine: options validation, filters, grouping, totals, CSV, PDF, email body, schedule date maths |
| `netlify/functions/_shared/time-report-mail.js` | Builds and sends one schedule's report through the shared Gmail mailbox |
| `netlify/functions/time-report-emails.js` | Daily scheduled function: claim → send → record (or put back on failure) |
| `netlify/functions/time-tracking.js` | New actions: `report`, `team-report`, `report-schedules`, `save-report-schedule`, `delete-report-schedule`, `send-report-schedule` |
| `netlify/functions/_shared/popups-gmail.mjs` | `buildMessage` accepts optional `attachments` (unchanged output without them) |
| `time-tracking/index.html` | Export report dialog + scheduled-email lists on My week and Team |
| `MIGRATION-time-report-schedules.sql` | `time_report_schedules` table |
| `netlify.toml` | Schedule for `time-report-emails`; 26s timeout for `time-tracking` |

## Tests

- `npm run test:time-access` — permission table includes the new actions (team-report = review).
- `npm run test:time-reports-db` — 36 checks (incl. personal-project permissions and the project tables) against real Postgres: pinning, filters, billable maths, schedule saving rules, exactly-once sending, retry, role loss, auto-pause.
- `npm run test:time-reports-ui` — Chromium end-to-end against the real handler + Postgres: contractor CSV/PDF + schedule; admin filtered team report, fortnightly schedule, edit, send-now failure, pause, delete.
