# Dropped students — Enrollment dashboard

Adds a **Status** column to `/enrollment` with a **Mark dropped** button and a
free-text reason. A dropped student:

- **stops counting as a student** — the Total Students card, the season tab
  badges and the programme sub-tab pills all go down by one
- **keeps counting as money** — their deal amount stays in Total Amount, and
  what they paid stays in Total Paid, so Outstanding stays honest
- **keeps their row**, tinted red, with the reason on hover

Nothing needs to be set up in HubSpot first. It works as soon as the site
deploys.

---

## How it is stored

The dashboard owns the record. It lives in **Netlify Blobs** (store
`enrollment-status`, key `drops.json`), written by
`POST /api/enrollment-status` and read back with the enrollment payload:

```json
{ "12345": {
    "reason": "Withdrew for medical reasons",
    "droppedBy": "Jake",
    "droppedByEmail": "jake@boulderdigitalmedia.com",
    "droppedAt": "2026-08-22T02:00:00.000Z",
    "studentName": "Delaney Hixon"
} }
```

Every change also writes a **note on the student's HubSpot deal** — what
happened, the reason, and who clicked — so there is a trail outside the
dashboard. That note is best-effort: if HubSpot is down the drop is still
recorded and the response says the note failed. HubSpot's own deal stage is
never touched; the deal stays Closed Won because the money was real.

### Why not a HubSpot property

A dropped student is a dashboard concept, not a HubSpot one — the deal is still
won. Using a property would mean creating `pd_dropped` and `pd_drop_reason` in
HubSpot before any of this worked, and would put a reason written for internal
reporting onto the sales record. If you later decide HubSpot should be the
source of truth, `_shared/drops.mjs` is the only file that knows where the
records live.

---

## The counting rule

Written once on each side and named the same way, because it is the part that
is easy to get subtly wrong:

| | Total Students / tab badges | Total Amount / Total Paid |
|---|---|---|
| Active student | counted | counted |
| **Dropped student** | **not counted** | **counted** |
| College Credit / no PD Program | not counted | not counted |

Server: `countsAsStudent()` / `countsAsMoney()` in
`netlify/functions/enrollment.js`.
Browser: the same two functions in `enrollment/index.html`.
**Change them together** — `test/enrollment-drops.test.mjs` locks the server
side and `test/drop-student.smoke.mjs` locks what the page actually renders.

---

## Who can mark someone dropped

`POST /api/enrollment-status` requires a **verified** Netlify Identity session
(the token is checked against GoTrue, not merely decoded — `/api/*` is excluded
from `auth-gate.js`, so this check is the only thing in front of it) and one of:

```
admin, operations, programs, admissions
```

Override with `ENROLLMENT_DROP_ROLES` (comma-separated) in Netlify. `GET` is
open, matching `/api/enrollment`, which already serves the same data to the same
page.

A reason is **required** — a drop with no reason is a mystery six months later.
Putting a student back needs no reason and clears the record.

---

## Environment

| Variable | Needed? | What for |
|---|---|---|
| `HUBSPOT_TOKEN` | already set | the audit note on the deal. Without it the drop still saves and the note is skipped. |
| `URL` | set by Netlify | verifying Identity tokens. |
| `ENROLLMENT_DROP_ROLES` | optional | override the roles allowed to mark a drop. |

Netlify Blobs needs no configuration on a deployed site.

---

## Failure behaviour

- **Blobs unreachable on read** — the table still renders in full. The payload
  carries `dropsAvailable: false` and the subtitle says the student count may be
  too high, rather than quietly showing everyone as active.
- **Blobs unreachable on write** — the request fails with "Nothing was saved".
  It never reports a save it did not make.
- **HubSpot note fails** — the drop is saved; the response carries a warning.
- **No permission** — the popup shows the server's reason and stays open, and
  nothing on the page changes.

---

## Files

| Path | What it is |
|---|---|
| `netlify/functions/_shared/drops.mjs` | Where the records live and their shape. The only file that knows about Blobs. |
| `netlify/functions/_shared/identity.mjs` | Verified-Identity check for `/api/*` write endpoints. |
| `netlify/functions/enrollment-status.mjs` | `GET`/`POST /api/enrollment-status`. |
| `netlify/functions/enrollment.js` | Reads the drops, attaches `dropped` / `dropReason` / `droppedBy` / `droppedAt` per deal, applies the counting rule. |
| `enrollment/index.html` | Status column, the reason popup, the red badge, and the same counting rule for the cards and pills. |
| `test/enrollment-drops.test.mjs` | 24 assertions — the counting rule and the endpoint's guard rails. `npm run test:drops` |
| `test/drop-student.smoke.mjs` | 32 assertions driving the real page in headless Chromium. `npm run test:drops-ui` |

`test/shirt-order.smoke.mjs` changed too: it addressed the T-shirt column as
`td:last-child`, which stopped being true when Status was added. It now selects
`td.shirt-cell`.
