# Apply Form dashboard

`/apply-form/` edits the online application served by the **pd-apply** site (apply.pacificdiscovery.org) and lists the applications it collects.

## Tabs

- **Form fields.** Live preview of Step 1 (About you) and Step 2 (Application). Click a field to change its label, help text, type, choices, required/half-width/private flags, the "only show when…" conditions, and which HubSpot contact or deal property it writes to. **+ Add field** creates a new question. "Hide from applicants" retires a question but keeps past answers. Core fields (name, email, DOB, mobile, program, travel dates) can be reworded but not removed.
- **Programs & dates.** The program list with type (gap semester / mini / summer), price (becomes the deal amount), HubSpot **PD Program** value and on/off, plus the travel dates offered. The program type and the travel season decide which pipeline the deal moves into when the fee is paid.
- **Fee, interview & text.** Application fee, card-fee % and ACH-fee % (bank debit, used for deposits and tuition payments), the refund wording shown on the payment screen and Stripe page, the "application fee received" email (subject, message, on/off), the HubSpot meetings link for step 3, the wording on each screen, and the Jotform form IDs used by the mirror.
- **Terms.** The Program Terms & Conditions. Edit the text (headings, numbered lists, bold, links — the help line under the box shows how), check the preview, then **Publish terms**. Each publish is a new version; pd-apply serves the latest to the website page, the application-fee email, the Stripe payment page and (later) the acceptance page, and records on each payment which version the family saw. **Import from website** pulls the current pacificdiscovery.org terms page into the draft as a starting point. **Versions** lets you view any old version or copy it back into the draft. The Terms tab has its own Publish button — the header's Publish is for the form.
- **Applications.** Every applicant with their progress (application → full application → interview → fee), the answers, and the Jotform/HubSpot sync status. Use **Retry sync** after fixing a HubSpot problem, and **Mark withdrawn** to hide an application from the portals.

Changes autosave as a draft. Applicants see them only after **Publish** (live within about 30 seconds). Every publish is kept under **Versions** and can be restored.

Who can use it: admins plus anyone granted the dashboard (default roles admin, admissions, outreach). Publishing needs one of `APPLY_FORM_PUBLISH_ROLES` (default `admin,admissions,outreach`).

## Setup

1. Run `MIGRATION-apply.sql` and `MIGRATION-terms.sql` in the Neon SQL editor.
2. Env vars on this site: `APPLY_SITE_URL=https://apply.pacificdiscovery.org` and `APPLY_SERVICE_KEY` (the same secret as pd-apply). `HUBSPOT_TOKEN` and `JOTFORM_API_KEY` are already set.
3. Open the dashboard. The first visit seeds the form from the live Jotform forms (`apply-form/seed-schema.json`). Review it, then Publish.

## Files

| File | |
|---|---|
| `apply-form/index.html`, `apply-form/editor.js` | the editor |
| `apply-form/form-kit.mjs` | pinned copy of pd-apply's form engine (`npm run sync:form-kit -- ../pd-apply`) |
| `apply-form/terms-kit.mjs` | pinned copy of pd-apply's terms / email-message format (keep in step with `pd-apply/public/terms-kit.mjs`) |
| `MIGRATION-terms.sql` | the terms document and its published versions (shared with pd-apply) |
| `apply-form/seed-schema.json` | snapshot of the two Jotform forms, used to set the form up the first time |
| `netlify/functions/apply-forms.mjs` | API (draft/publish/versions, HubSpot property lists, Jotform question creation, applications) |
| `netlify/functions/_shared/apply-form-access.mjs` | who may edit or publish |
| `netlify/functions/_shared/apply-source.mjs` | lets Enrollment (T-shirt sizes and addresses) and Sales Funnel (attribution) read pd-apply applications alongside Jotform |
| `MIGRATION-apply.sql` | tables shared with pd-apply |

Tests: `npm run test:apply-forms` (API) and `npm run test:apply-form-ui` (editor in Chromium). Both need `TEST_PG_URL` pointing at a local Postgres with the migration applied, and the `pg` driver installed locally (`npm i --no-save pg`). It isn't added to package.json, so deploys are unaffected.

## Program Terms & Conditions on the website

Once version 1 is published, paste this into the terms page on pacificdiscovery.org (HTML / custom code block), replacing the old text:

```html
<div id="pd-terms"></div>
<script src="https://apply.pacificdiscovery.org/terms-embed.js" defer></script>
```

The page then shows whatever is live in the Terms tab (refreshes within a minute of publishing). A stand-alone copy is at `https://apply.pacificdiscovery.org/terms`, and `…/terms?v=3` shows a specific version.
