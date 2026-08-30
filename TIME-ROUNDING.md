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

## Existing entries — the retroactive pass

Nothing rounds automatically on deploy. Entries logged before this change keep
their exact minutes until an admin runs the back-fill, under
**⚙️ Projects → Round historical entries**.

**Preview first, always.** The tool reports, per contractor, how many entries
would change, the before and after totals, and — where a rate is on file — what
the change is worth in money. That last column is the point: "+42 minutes"
doesn't mean anything until it reads "+NZD 56.00". Nothing is written until you
press the second button.

**Dates are optional.** Leave them blank for all history, or window it to a
financial year.

**It only touches unapproved entries** (`locked = FALSE AND approval_id IS
NULL`). Anything on an approved timesheet is excluded and counted separately in
the preview, so the numbers reconcile. Moving a total someone has signed off —
let alone one behind an issued invoice — is not something a button should be able
to do. If an approved entry genuinely needs correcting, undo the approval first.

**Running timers are excluded**, so a live entry can't be rounded mid-tick.

### Getting it back

The commit returns every entry's prior value and the browser saves them as
`time-rounding-backup-<date>.csv` before showing the result. To reverse a run:

```sql
-- from the CSV: entry_id, minutes_before, minutes_after
UPDATE time_entries SET minutes = <minutes_before> WHERE id = <entry_id>;
```

There's no schema column tracking this — a cleanup that runs once doesn't earn
one — so **keep the CSV** if you might want the run back.

## Tests

```
npm run test:time-import        # no database needed
npm run test:time-rounding-db   # needs DATABASE_URL
```

The first covers the pure rule: exact quarters, nearest-not-up-not-down, the
7.5-minute midpoint, the short-entry floor, the 24h cap, and that rounding is
applied *after* validation so a zero-length entry is still refused rather than
floored into existence.

The second is the one that matters for the SQL. Because the rule is written
twice — JavaScript and SQL — and two dialects of one rule is precisely the
arrangement that drifts, it runs the real handler against a real PostgreSQL and
compares `handleStop`'s expression to `roundMinutes()` across every duration from
1 minute to 24 hours plus the exact midpoints. It also pins the back-fill's blast
radius: approved, paid and running entries must come through untouched, and the
before-values must restore exactly. It works in a throwaway schema and drops it
afterwards, and skips cleanly when `DATABASE_URL` isn't set.

```
initdb -D /tmp/pgd -U postgres --auth=trust
pg_ctl -D /tmp/pgd -o "-k /tmp/pgrun -p 5433" start
DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
  npm run test:time-rounding-db
```
