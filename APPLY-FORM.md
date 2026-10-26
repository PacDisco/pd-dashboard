# Apply Form dashboard

`/apply-form/` edits the online application served by the **pd-apply** site (apply.pacificdiscovery.org) and lists the applications it collects.

## Tabs

- **Form fields.** Live preview of Step 1 (About you) and Step 2 (Application). Click a field to change its label, help text, type, choices, required/half-width/private flags, the "only show when…" conditions, and which HubSpot contact or deal property it writes to. **+ Add field** creates a new question. "Hide from applicants" retires a question but keeps past answers. Core fields (name, email, DOB, mobile, program, travel dates) can be reworded but not removed.
- **Programs & dates.** The program list with type (gap semester / mini / summer), price (becomes the deal amount), HubSpot **PD Program** value and on/off, plus the travel dates offered. The program type and the travel season decide which pipeline the deal moves into when the fee is paid.
- **Fee, interview & text.** Application fee, card-fee % and ACH-fee % (bank debit, used for deposits and tuition payments), the refund wording shown on the payment screen and Stripe page, the "application fee received" email (subject, message, on/off), the **application-fee reminders** (on/off and the four emails), the HubSpot meetings link for step 3, the wording on each screen, and the Jotform form IDs used by the mirror.
- **Terms.** The Program Terms & Conditions. Edit the text (headings, numbered lists, bold, links — the help line under the box shows how), check the preview, then **Publish terms**. Each publish is a new version; pd-apply serves the latest to the website page, the application-fee email, the Stripe payment page and (later) the acceptance page, and records on each payment which version the family saw. **Import from website** pulls the current pacificdiscovery.org terms page into the draft as a starting point. **Versions** lets you view any old version or copy it back into the draft. The Terms tab has its own Publish button — the header's Publish is for the form.
- **Applications.** Every applicant with their progress (application → full application → interview → fee), the answers, and the Jotform/HubSpot sync status. Use **Retry sync** after fixing a HubSpot problem, and **Mark withdrawn** to hide an application from the portals.

Changes autosave as a draft. Applicants see them only after **Publish** (live within about 30 seconds). Every publish is kept under **Versions** and can be restored.

Who can use it: admins plus anyone granted the dashboard (default roles admin, admissions, outreach). Publishing needs one of `APPLY_FORM_PUBLISH_ROLES` (default `admin,admissions,outreach`).

## Setup

1. Run `MIGRATION-apply.sql`, `MIGRATION-terms.sql`, `MIGRATION-reminders.sql` and `MIGRATION-decisions.sql` in the Neon SQL editor.
2. Env vars on this site: `APPLY_SITE_URL=https://apply.pacificdiscovery.org` and `APPLY_SERVICE_KEY` (the same secret as pd-apply). `HUBSPOT_TOKEN` and `JOTFORM_API_KEY` are already set.
3. Open the dashboard. The first visit seeds the form from the live Jotform forms (`apply-form/seed-schema.json`). Review it, then Publish.

## Files

| File | |
|---|---|
| `apply-form/index.html`, `apply-form/editor.js` | the editor |
| `apply-form/form-kit.mjs` | pinned copy of pd-apply's form engine (`npm run sync:form-kit -- ../pd-apply`) |
| `apply-form/terms-kit.mjs` | pinned copy of pd-apply's terms / email-message format (keep in step with `pd-apply/public/terms-kit.mjs`) |
| `MIGRATION-reminders.sql` | reminder state and emailed "continue your application" links on `applications` |
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

## Application-fee reminders

For applicants who finished the full application but haven't paid. pd-apply checks hourly and emails the student and every parent/guardian from admissions@ **1, 4, 10 and 21 days** after the application was completed, each with a personal link back to their application. At **28 days** an unpaid application is marked **Closed (unpaid)** — a label only; the link still works if they pay later.

- **Switch on:** Fee, interview & text → *Reminders* → tick *Send reminders*, then **Publish**. Only applications completed after you switch on get reminders, so the backlog is never emailed. Switching off and on again starts afresh.
- **Wording:** each of the four emails can be edited or switched off (expand it in the same panel). Empty = the default.
- **One applicant:** Applications → open them → *Fee reminders* shows what was sent, when and to whom, with **Stop reminders** / **Resume reminders** (resume also re-opens a closed application).
- Reminders stop by themselves when the fee is paid or the application is marked withdrawn. If the job missed some days it sends only the latest reminder, never several at once.

## Accept / decline

Open an applicant in **Applications**. The *Decision* box has **Accept** (once the fee is paid) and **Decline**. Only admins and admissions can use them (`APPLY_DECISION_ROLES`, default `admin,admissions`).

- **Accept** holds their place for 7 days for the $2,250 deposit and moves the HubSpot deal to *Interview Complete* (it moves on to *Deposit Paid/Customer* when they pay). The acceptance email with the deposit and payment options comes with the next update — until then, contact the family yourself.
- **Decline** asks for an optional personal message and whether to refund the application fee (ticked by default; unticked if they'd already been accepted, since the fee is then non-refundable). The refund goes through Stripe first, then the student and parents get the *not accepted* email (edit it under Fee, interview & text), the deal moves to *Closed Lost*, and reminders stop. A decline can't be undone here.

Filters: **Accepted** and **Declined** next to the progress filters. An interview booked outside the application (from an email or by admissions) is picked up from HubSpot automatically and shown as *found in HubSpot*.
