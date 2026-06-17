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
- **Status logic:** if the document has a signature field, a filled signature →
  `Signed`, an empty one → `Awaiting signature`. If there's no signature field, a
  completed submission shows as `Signed`. JotForm Sign has no API for invitations
  that were sent but never opened, so those don't appear until there's a submission.

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
