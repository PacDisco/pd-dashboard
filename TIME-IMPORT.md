# Time Tracker — bulk import

Paste a block of hours out of Excel or Google Sheets instead of typing entries
one at a time. Lives behind **⭱ Bulk import**, next to *Add entry by hand* on
the My week tab.

## Before it works: run the migration

```
netlify db exec < MIGRATION-time-import.sql
```

It adds `import_batch_id` to `time_entries`, widens the `source` check to allow
`'import'`, and adds two indexes. Idempotent — safe to re-run. Without it every
import fails at the insert.

## How it behaves

**Paste is the primary input**, a CSV file picker is the fallback. The hours are
already in a spreadsheet; copying a block skips save-as-CSV, the file dialog and
the encoding bugs, and it works on a phone.

**Nothing saves until you've seen the preview.** The paste is validated by the
server first (`dry_run`), and the preview table is the server's verdict, not the
browser's guess at one. Every line of the paste appears, in order, with its
original line number, so "line 37" means line 37 in the spreadsheet.

**All-or-nothing on commit.** One multi-row `INSERT`, atomic in Postgres. A batch
lands whole or not at all.

**Every import can be undone.** Rows carry a batch id; a bar appears after the
import with *Undo this import* and stays until used or dismissed. Undo refuses a
batch containing any approved row rather than deleting around it.

## Columns

A header row is matched **by name, in any order**. Unrecognised columns are
listed as ignored rather than silently dropped.

| Column | Accepts | Notes |
|---|---|---|
| **Date** | `2026-08-24`, `24/08/2026`, `24 Aug 2026`, `Aug 24, 2026` | required |
| **Project** | project name or its code (`WEB`) | optional; case-insensitive |
| **Description** | free text | optional |
| **Started** / **Finished** | `9:00`, `09:00`, `0900`, `9am`, `5:30 PM` | a finish before the start reads as crossing midnight |
| **Hours** | `1.5`, `1:30`, `1h 30m`, `90m` | use *either* Started+Finished *or* Hours |
| **Email** | sign-in email | admin only; omit and everything lands on you |

Also accepted as looser synonyms: `Day`/`When`, `Code`/`Job`/`Client`,
`Notes`/`Task`, `From`/`In`, `To`/`Out`, `Duration`/`Qty`, `Contractor`/`Person`.

With no header row at all, columns are read in the order the dashboard's own CSV
export writes them, so **an exported week pastes straight back in**.

Imported rows are logged exactly as given. Quarter-hour billing is applied to
totals, not to individual entries — see TIME-ROUNDING.md.

### Two things worth knowing

- **Slash dates are read day/month.** `03/04/2026` is 3 April. The preview says
  so whenever a slash date made it through — check a row before importing.
- **The person column must hold an email.** A name is refused with a message
  rather than quietly reassigned, because the silent failure puts one person's
  hours on whoever pasted them. That's why the CSV export carries an `Email`
  column alongside `Contractor`.

## What gets refused

| | |
|---|---|
| Unknown or archived project | error — fix the spelling or add it under Projects |
| Unknown email | error — that person has to open the Time Tracker once first |
| Deactivated contractor | error |
| A day inside an approved timesheet | error — undo the approval first |
| Longer than 24h, or finish ≤ start | error |
| More than 500 rows in one paste | error — split it |
| Looks already logged | **warning**, unticked by default, tick it to include |

The repeat check covers both what's already in the database and the same row
appearing twice within one paste. It's a warning, never a block: two identical
half-hour blocks on one day are legitimate.

## Permissions

Unchanged from the rest of the Time Tracker. A contractor's rows are pinned to
them whatever the sheet's email column says; only `admin` can import onto someone
else. Imported entries show an **imported** pill, and behave like any other entry
for approval and payment.

## Tests

```
npm run test:time-import
```

Covers the paste parser (lifted out of the shipped page, not duplicated, so the
tests fail if the page changes) and the server's row validator.

## API

Two actions on `netlify/functions/time-tracking.js`, both POST:

```
import-entries  { rows: [{ line, work_date, started_at, ended_at, project?, description?, contractor_email? }],
                  dry_run }          # dry_run defaults to true
undo-import     { batch_id }
```

`started_at` / `ended_at` are full ISO instants — the browser converts local date
plus clock time, keeping the timezone contract at the top of the function file.
The commit re-runs the whole validation rather than trusting the preview, since a
period can be approved between the two calls.
