# Instructor onboarding checklist — dashboard is now the source of truth

The instructor portal's **DOCUMENT CHECKLIST** used to read a HubSpot contact
property (`instructor_documents`) that nothing anywhere ever wrote — so an
instructor could fill in every form and every box stayed red until an admin
hand-ticked it in HubSpot. That checklist now reads this dashboard's Postgres,
the same `instructor_onboarding` table the Instructors page manages.

One list, two audiences: admins see it in the instructor drawer, instructors see
it in their portal.

## Setup — in order

1. **Run the migration** (safe to re-run):
   ```
   netlify db exec < MIGRATION-instructor-checklist.sql
   ```

2. **Generate a shared secret and set it on BOTH Netlify sites** as
   `INSTRUCTOR_PORTAL_KEY`:
   ```
   openssl rand -hex 32
   ```
   The endpoint refuses to start with a key under 24 characters.

3. **On the instructor portal site only**, set:
   ```
   INSTRUCTOR_API_URL = https://<this-dashboard-site>/api/instructor-checklist
   ```

4. **Deploy both**, then open **Instructors** and click **⟳ Sync from Jotform**
   once. That backfills the new Signed Contract item and classifies every
   already-uploaded document into its checklist item.

## The 14 items

| Key | Label | Completed by |
|---|---|---|
| `contract` | Signed Contract | Form 261608232937056 |
| `personal_info` | Personal Information | Form 261748248196873 |
| `policy_device` | Device Policy | Form 261722834653056 |
| `policy_drug_alcohol` | Drug & Alcohol Policy | Form 261727420881863 |
| `policy_flight` | Flight Policy | Form 261727594157871 |
| `policy_money` | Money & Credit Card Policy | Form 261726712606861 |
| `policy_first_aid` | First Aid Kit Policy | Form 261727467730867 |
| `policy_van` | Van Use Policy | Form 261756536759069 |
| `doc_passport` | Passport | Upload form 261607538438868 |
| `doc_drivers_license` | Drivers License | ” |
| `doc_wfr` | WFR Certificate | ” |
| `doc_police_check` | Police/FBI/Background Check | ” |
| `doc_photos` | 2 Photos | ” |
| `doc_visa` | Visa | ” |

The seven pre-existing keys are unchanged, so no live data was re-keyed. Every
instructor's count moves from `x/7` to `x/14`, which means most will now match
the roster's **missing paperwork** filter — that's the point of the unification,
not a bug.

Edit the list in `netlify/functions/_shared/instructor-checklist.js`. Both the
dashboard and the portal read it from there, so they can't drift.

## How a document gets credited

`Sync from Jotform` and the portal endpoint both use the same rule, and neither
will credit a document on the strength of a dropdown selection alone:

* **Structural pairing** — a document type is credited when the upload field
  that follows it actually holds a file. The pairing is consumed at that field
  whether or not a file is there, so a type picked against an empty field is
  discarded rather than drifting onto whatever is attached further down.
* **Filename evidence** — every uploaded file's own name is matched
  (`Barker_license.jpeg`, `Olivia Kitzerow Criminal History.pdf`). This recovers
  uploads put in the wrong field, and it is the only way **Visa** can tick — the
  dropdown has no Visa option.

**No file, no credit.** On 8 of the 12 real upload submissions somebody picked a
document type and attached nothing. Crediting on selection would put a green
tick against a WFR wilderness-first-aid certificate that doesn't exist. A missed
tick is recoverable; a false one on a safety credential isn't.

Files are also stored in `instructor_documents` with a real `doc_type`
("Passport", "WFR Certificate") instead of the upload widget's generic
"Additional file upload" label, so the documents list is finally searchable.

## Pinned items

Toggling a checkbox in the instructor drawer writes `source = 'manual'` and the
row shows **pinned**. The Jotform sync will never change a pinned row again.
That's what makes un-ticking stick — a rejected police check, an expired WFR
cert. Previously the next sync silently re-ticked it.

The migration backfills `source = 'manual'` onto any row currently sitting at
`completed = FALSE`, because the old sync could only ever write `TRUE` — so
those must have been deliberate hand overrides.

To hand an item back to automatic detection, POST `set-onboarding` with
`source: 'jotform'`.

## The portal endpoint

```
GET /api/instructor-checklist?email=someone@example.com
X-PD-Service-Key: <INSTRUCTOR_PORTAL_KEY>
```

Returns all 14 items with `completed`, plus `found`, `complete`, `total`. An
instructor with no profile still gets the full list, all incomplete.

It re-derives from Jotform for that one email before answering, so a form
submitted a minute ago already shows — the DB alone would be stale until someone
clicked Sync. Anything genuinely new is written back, so **the dashboard stays
current as a side effect of instructors using their portal**. Results are cached
per-email for `CHECKLIST_CACHE_MS` (default 60s); `?fresh=0` reads the DB only.

Degradation is one-directional: a Jotform outage can only under-report. A stored
tick is never removed by a failed derive.

## ⚠ Pre-existing: `/api/*` is unauthenticated

Not introduced by this change, but worth knowing since the checklist adds
personal data to that surface.

`netlify.toml` maps `/api/*` → `/.netlify/functions/:splat` with no role
condition, and `auth-gate.js` explicitly lists `/api/*` in its `excludedPath`.
Only `/api/config` and `/api/users` have `Role=` lines in `_redirects` — and
Netlify's redirect parser discards those two anyway, because a non-wildcard rule
with no destination is rejected as *Missing "to" field*.

Net effect: `GET /api/instructors?action=list` returns every instructor profile
to anyone who asks, and `POST /api/instructors?action=delete` is reachable too.

**Do not "fix" this by adding `/api/*  200!  Role=...` to `_redirects`.**
`_redirects` is processed before `netlify.toml` and first match wins, so a
wildcard rule with no destination expands to a forced self-rewrite
(`/api/:splat`) that shadows the function mapping — every dashboard data call
404s. (I tried exactly that; it breaks the dashboard.)

The reliable fix is in `auth-gate.js`, which already runs at the edge and
already reads live per-dashboard permissions:

1. Remove `"/api/*"` from `excludedPath` in `netlify.toml`.
2. In `auth-gate.js`, before the slug lookup, special-case the API:
   ```js
   if (slug === "api") {
     // Shared-secret endpoints authenticate themselves — no Identity session.
     if (url.pathname.startsWith("/api/instructor-checklist")) return context.next();
     if (!roles.length) return unauthorized("Sign in required.");
     return context.next();
   }
   ```

Worth testing on a deploy preview first — every dashboard page's data calls go
through this path.

## Tests

```
npm test
```

83 cases, offline: document classification against all 12 real upload
submissions, the next-of-kin mis-crediting case, endpoint auth, `alt_emails`
resolution, manual pins surviving contradicting evidence, and Jotform-outage
degradation. The migration was verified against a real PostgreSQL 16 — run three
times for idempotency, with the pin backfill and the no-tuple-churn upsert
confirmed.

## Files

| File | Role |
|---|---|
| `netlify/functions/_shared/instructor-checklist.js` | Canonical 14 items + Jotform classification (new) |
| `netlify/functions/instructor-checklist.js` | Portal-facing read API (new) |
| `netlify/functions/instructors.js` | Sync now covers the contract form + classified documents |
| `MIGRATION-instructor-checklist.sql` | `source` column, pin backfill, label normalisation |
| `instructors/index.html` | Drawer groups forms vs documents, shows pins |
| `test/instructor-checklist.test.mjs` | The suite |
