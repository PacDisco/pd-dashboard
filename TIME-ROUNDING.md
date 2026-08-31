# Time Tracker — quarter-hour billing

Time is billed in quarter hours. **Entries store exact minutes; the rounding is
applied to totals.**

That distinction is the whole design, and getting it the other way round costs
real money.

## Why not round each entry

Rounding every entry and then adding them up accumulates the per-entry errors
instead of cancelling them. Each entry can lose up to 7 minutes, and nothing
brings them back — so the loss grows with the number of entries.

A real fortnight: 14 entries whose true durations total **938 minutes
(15.63 h)**.

| | |
|---|---|
| Round each entry, then sum | 915 min = **15.25 h** |
| Round the total | 945 min = **15.75 h** |

23 minutes of worked time, gone, on one person's fortnight. The larger the entry
count, the worse it gets. `roundBillableMinutes()` in
`netlify/functions/time-tracking.js` is the one rounding step, and
`test/time-import.test.mjs` has a test that fails if per-entry rounding ever
comes back.

## Where the rounding happens

```
nearest 15 minutes · zero stays zero · any non-zero total bills at least 15
```

| Rounded | Not rounded |
|---|---|
| The week total (the big number on My week) | Individual entries |
| A contractor's period total on the Team tab | The per-day and per-project breakdowns |
| An approved timesheet's `total_minutes`, and the payout amount computed from it | `started_at` / `ended_at`, ever |

The day and project breakdowns stay exact deliberately: they're working, not
billing, and rounding each of them would no longer add up to the total above
them.

There is **no 24-hour cap** on the total rounding. `MAX_MINUTES` bounds a single
entry; a week's total is expected to exceed it, and capping it would silently
truncate anyone who worked more than a day in the period.

## One rule, two dialects

The rule is written twice — `roundBillableMinutes()` in JavaScript, and
`ROUND_TOTAL_SQL` for the totals computed in the database. That is exactly the
arrangement that drifts, so `test/time-rounding.db.test.mjs` runs the shipped SQL
expression (imported, not copied) against the JavaScript across every total from
0 to five days, and fails on any disagreement.

**A gotcha this already caught:** in the neon tagged-template form,
`` sql`… ${EXPR} …` `` turns `${EXPR}` into a **bind parameter**, not SQL. Any
query that needs the rounding expression must use `sql().query(text, args)`
instead. `handleApprove` is written that way for this reason — the tagged-template
version failed at run time with `operator does not exist: text / numeric`.

## Changing the granularity

Two constants at the top of `netlify/functions/time-tracking.js`:

```js
const ROUND_TO_MINUTES     = 15;
const MIN_BILLABLE_MINUTES = 15;
```

Six-minute billing is `6` and `6`. `billed()` in `time-tracking/index.html`
mirrors the rule for display only and needs the same edit — the server's answer
is always what gets paid.

## Restoring entries that were rounded individually

An earlier version rounded each entry as it was saved. If that version ran
against your data, those entries are now wrong at source and the totals built on
them are wrong too.

Nothing was lost: `minutes` has always been derived from `started_at` /
`ended_at`, and those instants were never rounded, so every affected entry's true
duration is recoverable from its own row.

**⚙️ Projects → Restore exact entry times** (admin only) does that.

- **Preview first.** Per contractor: what's stored, what the recorded times
  actually say, and what each of those totals *bills* once rounded. The billed
  columns are the ones that matter — a nine-minute correction to a raw sum may
  not move the invoice at all, and the admin should be able to see that rather
  than guess. Money is shown where a rate is on file; someone with no rate reads
  "no rate", not "$0".
- **Totals span the person's whole unapproved set**, not just the rows being
  corrected, so "billed 15.25 h → 15.75 h" describes the actual invoice.
- **Only unapproved entries** (`locked = FALSE AND approval_id IS NULL`).
  Approved and paid entries are excluded and counted separately. Running timers
  are excluded.
- **Dates optional** — blank for all history, or window it.
- **The commit saves `time-minutes-backup-<date>.csv`** with every prior value
  before showing the result. Reversing a run is one UPDATE per row from that
  file. There is no schema column tracking this, so **keep the CSV** if you might
  want the run back.

If your entries were never rounded individually, this will report nothing to
correct — which is the expected result, not a failure.

## Tests

```
npm run test:time-import        # no database needed
npm run test:time-rounding-db   # needs DATABASE_URL
```

The second is the one that matters. It runs the real handler against a real
PostgreSQL and checks, end to end, that a period of 938 exact minutes approves as
945 and not 915; that a stopped timer and a by-hand entry both store their exact
minutes; that the roster reports the rounded total alongside the exact one; and
that the restore tool never reaches an approved, paid, or running entry and hands
back before-values good enough to restore from. It works in a throwaway schema,
drops it afterwards, and skips cleanly when `DATABASE_URL` isn't set.

```
initdb -D /tmp/pgd -U postgres --auth=trust
pg_ctl -D /tmp/pgd -o "-k /tmp/pgrun -p 5433" start
DATABASE_URL="postgres://postgres@localhost:5433/postgres?host=/tmp/pgrun" \
  npm run test:time-rounding-db
```
