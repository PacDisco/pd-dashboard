# Payment Plans dashboard (`/payment-plans/`)

What's coming in from families on payment plans, and when. Reads the plans
pd-apply stores (`applications.enrolment`, `MIGRATION-enrolment.sql`) from the
shared Neon database — no HubSpot or Stripe calls, so it loads instantly.

- **Tiles:** due in the next 30 / 90 days, scheduled on plans, received through
  plans (and this month), at risk, deposits not yet paid, and balances not yet
  scheduled (accepted families still choosing a plan / without a deposit).
- **Money in by month** (3 months back, 12 ahead), stacked: received,
  scheduled automatic instalments, balances the family pays themselves
  ("balance later"), at risk (failed, overdue, paused — placed at the retry date
  or today), and deposits not yet paid (hatched — not committed). Hover a month
  for the breakdown and the estimated processing fees; "Show as table" for the
  numbers.
- **Coming up:** every expected payment in the next 60 days.
- **Families:** plan, tuition, paid, still to pay, next payment and status;
  click a row for the full schedule and links to the HubSpot deal.
- **Term filter / search** recalculate everything; **Download CSV** exports the
  families and every open payment.

Amounts are tuition only (what counts toward the program). Card / bank fees are
charged on top and shown as an estimate. Times use admissions' time zone
(`INTERVIEW_TZ`, default America/Denver).

Access: admin, operations, admissions (`payment-plans/dashboard.json`; change it
in the dashboard's permissions like any other). The folder is picked up by the
build (`scripts/build-manifest.js`).

API: `GET /api/payment-plans?action=report` → `netlify/functions/payment-plans.mjs`
(`buildReport` is pure; tests in `test/payment-plans.test.mjs`).
