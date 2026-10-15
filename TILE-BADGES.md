# Tile badges — "new since you last opened it"

Dashboards that receive submissions show a coral count bubble on their
landing-page tile. Each person has their own count, and it clears when they
open the dashboard.

## Which dashboards, and what counts

| Dashboard | Counts | Source |
|---|---|---|
| Application Form | new applications | Neon `applications.created_at` |
| Field Budget | entries logged in the field app (exchange legs count once) | Neon `entries.received_at` (FIELD_BUDGET_DATABASE_URL) |
| Instructor Check-ins | new bookings | counter bumped by `checkins-book.mjs` |
| Instructor Field Reports | new reports | Jotform 250887973978080 |
| Instructors | new instructor applications | Jotform 241888714639876 |
| Invoices & Payments | invoices that arrived by **email** | Neon `payments` where `source = 'email'` |
| Website Popups | popup sign-ups | sum of `submits` in the popups `stats` blob |
| Sign Inbox | new signed documents | Jotform 261608232937056, 240655314816052, 251468552846063 |
| Student Document Uploads | new uploads | Jotform 261337066421856 |
| UE Application Assignments | new applications | Jotform 251396787451873 |

## How it works

- `GET /api/tile-badges` (netlify/functions/tile-badges.mjs) returns counts for
  the dashboards the caller may open (same access rule as the edge gate).
  Each source is read at most once a minute and shared across everyone.
- "Opened" is recorded two ways, both calling `POST /api/tile-badges {slug}`:
  the edge auth gate, whenever a badged dashboard's main page loads (so
  bookmarks count), and the landing page when a tile with a bubble is clicked.
- Per person we store a **cursor** — the newest submission's own timestamp (or
  the counter value) at the moment they opened it — in the `tile-badges` blob
  store under `seen/<email>`. New = anything past the cursor. The cursor comes
  from the source, never the wall clock, so Jotform's account-timezone
  timestamps compare correctly.
- The first time someone's badges load, they start at zero (no "99+" on day one).
- Counts look back 45 days, at most 100 items per source; more shows "99+".
- The landing page refreshes the counts every 2 minutes while it's visible and
  when you come back to it.

## Adding a dashboard

1. Add a source to `SOURCES` in `netlify/functions/_shared/tile-badge-sources.mjs`
   (`jotform(formId…)`, a Neon query returning epoch-ms `t`, or a counter).
2. Add the slug to `BADGED_SLUGS` in `netlify/edge-functions/lib/tile-badges.js`.
3. For a counter, call `bumpBadgeCounter("<slug>")` where the submission lands.

`npm run test:badges` checks the two lists match.

## Setup

Nothing new: uses the existing `JOTFORM_API_KEY`, `NETLIFY_DATABASE_URL`,
`FIELD_BUDGET_DATABASE_URL` and Netlify Blobs. No migration.
