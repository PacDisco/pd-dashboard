# Time Tracker — quarter-hour rounding

Every entry is billed in quarter hours. Rounding happens **on save**, in the
Netlify Function, at all four places an entry's length is set:

| | |
|---|---|
| Stopping the timer | `handleStop` — in SQL, from the database clock |
| Adding an entry by hand | `handleCreateEntry` |
| Editing an entry's times | `handleUpdateEntry` |
| Bulk import | `validateImportRow` |

The rule lives in one place, `roundMinutes()` in
`netlify/functions/time-tracking.js`:

```
nearest 15 minutes, floor 15, cap 1440 (24h)
```

## The three decisions behind it

**Rounded on save, not at approval.** The hours a contractor sees in their own
week are exactly the hours that get approved and invoiced. Rounding at payout
instead would leave those two numbers permanently disagreeing, with no way for
the person to check their own total.

**Nearest, not up or down.** 7 minutes → 0:00 (then the floor lifts it to 0:15);
8 minutes → 0:15; 22 → 0:15; 23 → 0:30. Over a month the over- and
under-rounding cancel instead of accumulating against one side.

**Floored at 15 minutes.** Without a floor a 3-minute entry rounds to zero and
then sits in the week list looking logged while being worth nothing on the
invoice — the kind of silent loss nobody notices until an invoice is short.
Anything deliberate enough to log is worth a quarter hour.

## What is *not* rounded

`started_at` and `ended_at` keep the true instants. Only `minutes` — the
billable quantity — is rounded. So an entry can legitimately read
`09:00 → 09:07` and `0.25 h`, and **nothing should recompute one from the
other**.

The UI says so rather than leaving it looking like a broken sum:

- the week list underlines any rounded duration, with the real clock time on hover
- stopping a short timer says "Logged 0h 15m (0h 07m rounded to the quarter hour)"
- the by-hand form previews the saved figure live as you type
- the import preview shows rounded minutes before you commit

## Changing the granularity

Two constants at the top of `netlify/functions/time-tracking.js`:

```js
const ROUND_TO_MINUTES     = 15;
const MIN_BILLABLE_MINUTES = 15;
```

Six-minute billing is `6` and `6`; no floor is `MIN_BILLABLE_MINUTES = 1`. Two
things follow the constants by hand and need editing to match:

- the SQL expression in `handleStop` (it interpolates the constants, but read it)
- `roundQuarter()` in `time-tracking/index.html`, which mirrors the rule for the
  by-hand preview only — the server's answer is always the one that's stored

## Existing entries

Nothing was back-filled. Rows logged before this change keep their exact
minutes, and approved timesheets are left alone on purpose — rewriting hours
behind an issued invoice should be a deliberate act, not a side effect of a
deploy.

To round the **unapproved** backlog:

```sql
-- Check first.
SELECT count(*) FROM time_entries
 WHERE locked = FALSE AND ended_at IS NOT NULL AND minutes % 15 <> 0;

UPDATE time_entries
   SET minutes = LEAST(1440, GREATEST(15, ROUND(minutes / 15.0) * 15))::int
 WHERE locked = FALSE AND ended_at IS NOT NULL AND minutes % 15 <> 0;
```

Approved rows are excluded by `locked = FALSE`. Do not widen that.

## Tests

```
npm run test:time-import
```

Covers exact quarters, nearest-not-up-not-down, the 7.5-minute midpoint, the
short-entry floor, the 24h cap, and that rounding is applied *after* validation
so a zero-length entry is still refused rather than floored into existence.

The `handleStop` SQL was checked against `roundMinutes()` on a real PostgreSQL 16
across every duration from 1 minute to 24h, plus the exact midpoints — no
disagreement.
