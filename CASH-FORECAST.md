# Cash Forecast

Driver-based group cash flow at `/cash-forecast/`. Programs, pax, costs and
payment rules are editable variables; the twelve-month position is recomputed
from them. Actuals sync from Xero.

This replaces the spreadsheet, not the existing `/cashflow/` dashboard — that
one compares saved workbook versions from Drive and still works. Run both while
you build confidence, then retire whichever you don't want.

- **Fiscal year:** April – March
- **Recognition:** September (Fall), January (Spring), June (Summer) — the month
  before each season starts
- **Cash:** deposit at booking, balance N days before departure
- **Treasury:** funds collected in USD, converted to NZD only as NZD is needed
- **Roles:** `admin`, `operations`

---

## Why this exists

The workbook it replaces had expected and actual figures in the same cells,
reconciled by hand-entered "Adjustments" rows. Several of those rows were pure
balancing plugs — `Overview!J20 = -SUM(E20:I20)` drops −118,463 into December
with no operational reason, and there are three more like it. The closing
balances for April–July were typed numbers rather than formulas, so the chain
didn't recalculate. Revenue used 1.65 hardcoded in seven cells while the
Assumptions sheet said 1.60.

Nothing here can hold a plug. If a number can be computed it is not stored, and
the only writable state is the assumptions themselves.

---

## Where things live

```
cash-forecast/
  index.html      the dashboard page
  app.js          client; imports engine.mjs directly
  engine.mjs      the forecast — pure functions, no I/O, no clock
  model.mjs       types and defaults
  dashboard.json  title, icon, allowedRoles

netlify/functions/
  cash-forecast.mjs        GET  /api/cash-forecast   read model + actuals
  cash-admin.mjs           POST /api/cash-admin      save / restore
  cash-xero-sync.mjs       hourly     pulls each org
  cash-fx-sync.mjs         daily 06:00 UTC, refreshes USD/NZD
  cash-xero-auth.mjs       one-time consent kickoff
  cash-xero-callback.mjs   catches the code, stores tokens
  _shared/cash-access.mjs  role gate
  _shared/cash-store.mjs   assumptions in Blobs, versioned
  _shared/cash-xero.mjs    token rotation, reports, tracking
  _shared/cash-fx.mjs      live rate series and trailing averages
```

`engine.mjs` sits in the public folder on purpose: the browser imports it as a
module and the functions import it via `../../cash-forecast/engine.mjs`. One
copy, so the page and the server can never disagree about the arithmetic.

Nothing existing was modified. `_redirects`, `dashboards.json` and
`dashboards.discovery.json` regenerate from `npm run build` and pick the new
folder up automatically.

---

## Access

Two independent gates, and both are needed:

1. **The page** — `auth-gate.js` reads `cash-forecast/dashboard.json` and only
   lets `admin` and `operations` load `/cash-forecast/`.
2. **The data** — `_shared/cash-access.mjs` verifies the Identity token with
   GoTrue on every call.

The second is not belt-and-braces. `/api/*` is excluded from `auth-gate.js` (see
the warning block in `_redirects`), so nothing checks a role before a request
reaches these functions. Reads are gated as well as writes: this payload is
group bank balances across all four entities, which is more sensitive than the
instructor emails that made `budget-admin.mjs` gate its reads.

Callers outside `READ_ROLES` get **404, not 403** — someone in `admissions`
poking at endpoints shouldn't learn a group cash API exists here.

To change who has access, edit `READ_ROLES` / `WRITE_ROLES` in
`_shared/cash-access.mjs` and `allowedRoles` in `cash-forecast/dashboard.json`.
Keep them in step; the first controls the data, the second controls the page.

---

## The two timelines

| | Driven by | Shows up as |
|---|---|---|
| **Cash** | Deposit at booking + balance N days pre-departure, spread by the booking curve | Bank position |
| **Recognition** | One event per season, the month before it starts | Revenue moved to sales |

The gap between them is deferred revenue, shown as its own row. It should rise
as cash lands and drop to zero in the recognition month. If it doesn't,
something is wrong with the inputs — the signal the workbook couldn't give.

## Treasury

Funds are collected in USD and converted only when the NZD account would fall
below the buffer.

| Row | Meaning |
|---|---|
| `USD received` | Landing in the USD account |
| `USD converted` | Sold this month, sized to the NZD shortfall — never more |
| `USD balance` | Held, unconverted, carrying rate risk |
| `NZD account` | **Whether you can pay a supplier** |
| `Total position` | NZD cash + unconverted USD at the planning rate; mark-to-market, not spendable |

A shortfall is never floored at the buffer. If there is no USD left to convert,
the NZD account goes negative and says so — quietly topping it up would be the
workbook's plug problem reinvented.

Headline rows are NZD-stated so columns add up; treasury rows are native USD.

## Currencies

Programs **sell in USD** and **pay suppliers in NZD**, so each program carries
two currency fields that convert independently. The workbook's "pax value" of
15,500 is USD — `Revenue!F3 = E3 * 1.65` — so a Fall place is NZD 25,575, while
the Fixed & Variable Costs sheet is NZD. One currency field applied to both
would inflate program costs by 65%.

## The planning rate

`cash-fx-sync` pulls the USD/NZD series daily from ECB reference rates via
Frankfurter (no key), falling back to exchangerate-api for spot. Pick 90/60/30-day
average, spot, or a pinned rate. Trailing windows count **published
observations**, not calendar days — the ECB publishes on business days, so a
calendar-day "30-day average" would be built from about 21 readings.

The Payment rules tab re-runs the year at the observed 90-day high and low.
Neither source is a dealing rate; your bank's spread sits on top.

---

## Environment variables

```bash
# Xero — OAuth2 app, "Auth Code" grant type (NOT a Custom Connection:
# those are single-org and paid per connection, so four entities = four subs).
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=https://<site>/.netlify/functions/cash-xero-callback
XERO_SETUP_KEY=              # openssl rand -hex 24; gates the one-time auth URL
# XERO_TENANTS=              # optional: pin which orgs sync, and their order
# XERO_PROGRAM_CATEGORY=     # optional: Xero tracking category holding programs
```

Scopes to request on the Xero app — read-only, granular (broad scopes work until
September 2027 but are deprecated):

```
offline_access
accounting.reports.banksummary.read
accounting.reports.balancesheet.read
accounting.reports.profitandloss.read
accounting.reports.aged.read
accounting.banktransactions.read
accounting.invoices.read
accounting.settings.read
```

Without `offline_access` there is no refresh token and the sync dies after 30
minutes.

## First run

1. Deploy. `npm run build` regenerates the manifests and `_redirects`.
2. Visit once, signed in to Xero as someone who can see all four organisations:
   `https://<site>/.netlify/functions/cash-xero-auth?key=YOUR_SETUP_KEY`
   **Tick every organisation on the consent screen** — one consent covers all of
   them, and missing one means running the flow again.
3. Invoke `cash-fx-sync` and `cash-xero-sync` once rather than waiting for the
   schedule.
4. Open `/cash-forecast/` and check the Xero actuals panel against Xero directly.

Step 4 matters. The report parsers were written against Xero's documented shapes,
not against your actual responses — report row nesting varies by org and
chart-of-accounts depth. Confirm the numbers before anyone plans on them.

---

## Known limits

- **Placeholder inputs.** Per-program pax, departure dates, supplier cost
  phasing, the booking curve, the deposit amount and the USD/NZD opening split
  are all seeded guesses. Any figure shown before you set these is a
  demonstration, not a forecast.
- **GST and PAYE are absent.** Neither existed in the workbook. For an NZ entity
  they are among the largest and lumpiest movements in the year. Add them as
  rows on the Overheads tab once you decide how to phase them — GST is
  two-monthly.
- **Refunds and cancellations.** The model assumes forecast pax convert to cash.
  A withdrawal rate per season would be the natural next variable.
- **Forward cover.** Conversion happens at the planning rate on the day NZD is
  needed. If you hedge, that is a variable the model does not have.
- **Xero actuals are not consolidated across currencies.** Reported per
  organisation and per currency, deliberately not summed.
- **Token refresh concurrency.** If two invocations refresh the Xero token at
  once, both rotate it and one write wins. Survivable inside Xero's 30-minute
  grace window, and the design keeps Xero calls on the single cron path so it
  shouldn't arise — but it isn't defended against.

## Tests

The engine has a suite covering recognition timing, deposit and balance
placement, deferred revenue returning to zero, the balance chain having no
breaks, independent price/cost FX conversion, curve normalisation, cash
collected before the year opens, and the treasury rules (conversion sized to the
shortfall, USD conserved, shortfalls left visible). It is not wired into
`npm test` here because that script runs a single named file; run it directly or
add it to the script when you next touch it.
