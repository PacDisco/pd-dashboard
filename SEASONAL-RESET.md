# Seasonal reset of the instructor checklist

Onboarding completion is *derived* from Jotform: every dashboard sync and every
instructor-portal load re-scans a person's Jotform submissions and re-ticks
whatever they satisfy. That is right for first-time onboarding, but it means a
box can't simply be un-ticked to start a new season — last season's upload is
still in Jotform, so the next portal load re-ticks it within ~60 seconds.

This change adds a **per-item cutoff** so a reset actually holds, while a
genuinely new submission this season still auto-ticks with no admin babysitting.

## What you get

1. **Scheduled reset (Dec 1, May 1, Jul 15, NZ time).** Clears **Signed
   Contract** and **Visa** for every instructor. Runs automatically — no button.
2. **Per-instructor review.** In an instructor's drawer, every checklist item has
   a small **↺ reset** control. Use it to re-request one person's Passport,
   Driver's Licence, WFR or Background Check (or any item) when you want them to
   provide it again.
3. **Reset for all.** The **↺ Reset for all** button (top of the Instructors
   page) clears one or more items for *every* instructor at once — for when a
   policy or document has changed and everyone must re-do it.

All three clear the box in **both** the admin dashboard and the instructor
portal's PI-folder checklist, because both read the one `instructor_onboarding`
table. No files already on record are deleted — only the tick and its evidence
cutoff change.

## How the cutoff works

A reset stamps `reset_at = now` on the row and sets it back to automatic
detection (`source = 'jotform'`, `completed = FALSE`). From then on a Jotform
submission credits that item **only if it was submitted after `reset_at`**. So:

* last season's contract/visa/passport stops counting → the box goes and stays
  red;
* the instructor's *new* submission this season is newer than the cutoff → the
  box ticks again automatically, in the dashboard and their portal.

A row that was never reset has `reset_at = NULL`, which means "count all
evidence" — exactly the original behaviour. First-time onboarding is unchanged.

Per the product decision, a reset also clears items that were **pinned** by hand
and hands them back to automatic detection.

## One-time setup

Run the migration (safe to re-run), after the two earlier instructor
migrations:

```
netlify db exec < MIGRATION-instructor-seasonal-reset.sql
```

It adds `instructor_onboarding.reset_at` and a `checklist_reset_log` audit
table. Then deploy. No new environment variables. The scheduled function picks
itself up on deploy (Netlify reads `export const config.schedule`).

## Changing the schedule or the items

Everything lives in `netlify/functions/seasonal-reset.mjs`:

* `SEASON_DATES` — the three boundaries, interpreted in `SEASON_TZ`
  (`Pacific/Auckland`). Add or change dates here.
* `RESET_ITEMS` — which items the *scheduled* job clears (`contract`,
  `doc_visa`). The per-instructor and reset-for-all tools can target any item.

The function runs daily at 13:00 UTC and does nothing unless that day is a
boundary in NZ time; it claims each boundary via a unique `run_key`
(`season-YYYY-MM-DD`) so a retry or double-fire resets only once.

## API

`POST /api/instructors?action=reset-onboarding`

```jsonc
{ "items": ["contract", "doc_visa"], "scope": "all" }        // every instructor
{ "item": "doc_passport", "scope": "instructor", "instructor_id": 42 }  // one
```

Returns `{ reset, scope, instructor_id, affected }`. Every reset is written to
`checklist_reset_log`.

## Tests

```
npm run test:seasonal
```

Offline: timestamp parsing, the cutoff gate (older evidence suppressed, newer
evidence credits, dateless/garbage handling), an end-to-end "last season vs this
season passport" case, and the reset write-path's item validation and scoping.

## Files

| File | Role |
|---|---|
| `MIGRATION-instructor-seasonal-reset.sql` | `reset_at` column + `checklist_reset_log` |
| `netlify/functions/seasonal-reset.mjs` | Scheduled Dec 1 / May 1 / Jul 15 job |
| `netlify/functions/_shared/onboarding-reset.js` | Shared reset write-path (used by the endpoint and the cron) |
| `netlify/functions/_shared/instructor-checklist.js` | `submissionCreatedAtMs` + `creditsAfterReset` cutoff helpers |
| `netlify/functions/instructors.js` | `reset-onboarding` action; cutoff-aware `markOnboarding` and sync |
| `netlify/functions/instructor-checklist.js` | Portal API: cutoff-aware derive, write-back and merge |
| `instructors/index.html` | Per-item ↺ reset in the drawer; **Reset for all** modal |
| `test/seasonal-reset.test.mjs` | The suite |
