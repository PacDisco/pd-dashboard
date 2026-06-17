# Sign Inbox

A read-only dashboard that shows signing status across your JotForm Sign documents
(contracts, waivers) so the team can see who's signed and who's still pending —
without anyone logging into JotForm.

## How it works

- The page calls the existing `/.netlify/functions/jotform` proxy (same one the
  other dashboards use). The proxy injects `JOTFORM_API_KEY` server-side, so **no
  API key lives in this HTML.**
- For each tracked document it pulls `/form/{id}/submissions`, then derives a
  signer name, email, status, and submitted date for each record.
- **Status logic (important):** each row is a signature *request* created from the
  Send Document page. Status is resolved in this order:
  1. A **Flow Status** field on the form (best signal): values like
     `completed` / `signed` → **Signed**, `in progress` / `pending` →
     **Awaiting signature**, `declined` / `void` → **Declined**.
  2. A filled **signature field** → **Signed**; empty → **Awaiting signature**.
  3. Otherwise → **Sent** (a request was created, but signing can't be confirmed).

  JotForm Sign has **no API for live signing progress**. The contract trigger
  form's `Flow Status` field is currently empty on every submission, so all rows
  show **Sent**. To get real `Signed` status, configure the JotForm **Workflow**
  to write the outcome back into the `Flow Status` field when the document is
  completed (Workflow → after the Sign step, add an "Update Field" / "Edit
  Submission" action that sets Flow Status = Completed). Once that runs, this
  dashboard will show **Signed** automatically — no code change needed.

## Configuring which documents to track

Edit the `SIGN_FORMS` array near the top of `index.html`:

```js
SIGN_FORMS: [
  { label: "Instructor Contract",        id: "261608232937056" },
  { label: "Student Waiver & Liability", id: "240655314816052" },
  { label: "Permissions & Waiver (U18)", id: "251468552846063" }
],
```

`id` is the numeric form ID in the document's JotForm URL. Add, remove, or rename
freely. The IDs above are pre-filled from your account — confirm they're the
documents you actually send for signature.

## Deploy

No special steps. It's a normal dashboard folder:

1. Commit the `sign-inbox/` folder.
2. The build step (`scripts/build-manifest.js`) auto-discovers it and adds it to
   `dashboards.json` / `dashboards.discovery.json` and `_redirects`.
3. `JOTFORM_API_KEY` must already be set in Netlify (it is — `jotform.js` uses it).

Permissions: defaults to `admin`, `admissions`, `operations` (see `dashboard.json`).
Adjust there or via the admin permissions UI.
