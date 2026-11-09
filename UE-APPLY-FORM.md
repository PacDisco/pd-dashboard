# Unearthed Application Form dashboard

`/ue-apply-form/` edits the Unearthed online application served by the **ue-apply** site (`apply.unearthededucation.org`) and lists everyone who applies. Separate from Pacific Discovery's Apply Form: its own tables, its own access (roles admin · operations · unearthed).

## Tabs

- **Questions** — live preview of *About you* and *Your application*. Click a question to reword it, change help text, type, options, required / half width / sensitive / hidden, its "only show when…" rules, and an extra HubSpot contact property to save the answer to. Questions imported from Jotform keep their Jotform field ID (so the portals keep reading them) — hide those rather than delete them. Name, email, date of birth and the primary contact's name and email can't be removed. **Import from Jotform** rebuilds the questions from the live form (the permissions packet, wording and emails are kept; the old questions stay under Versions).
- **Permissions packet** — the waiver the parent signs in step 3: intro, parts (each initialled; a part can be "students under 18 only") and the declaration. Starts with the wording from the Jotform waiver. The exact wording signed is stored with each signature, so editing never changes past ones.
- **Trips & links** — one link per school trip: pick the Unearthed Program record in HubSpot, name the link (`apply.unearthededucation.org/<name>`), and optionally override the deposit / currency (otherwise `payment_amount_1` and `program_currency` from HubSpot), set a closing date or a number of places, or close it. A link's name is locked once someone has applied.
- **Wording & emails** — card fee %, the Jotform form the portals read, the intro on each step, and the four emails (continue link, parent signing request, signed copy, deposit received).
- **Applications** — everyone by trip and progress. *Needs attention* = a HubSpot/Jotform step failed, or applied but the permissions packet isn't signed. Open one to see answers (sensitive answers blurred until clicked), uploads, the signed PDF, deposit, and what reached HubSpot / Jotform with **Retry**. *Email the signing link* (re)sends the waiver to a parent. **Add from HubSpot** brings in a student who applied on the old Jotform form — it links their contact, deal, program and Jotform answers; nothing is changed in HubSpot or Jotform.

Changes autosave as a draft; applicants see them after **Publish** (live within ~30 seconds). Every publish is kept under **Versions**.

## Setup

1. Run `MIGRATION-ue-apply.sql` in Neon.
2. Env vars on this site: `UE_APPLY_SITE_URL=https://apply.unearthededucation.org`, `UE_APPLY_SERVICE_KEY` (same secret as `APPLY_SERVICE_KEY` on ue-apply). `HUBSPOT_TOKEN` and `JOTFORM_API_KEY` are already set.
3. Open the dashboard → **Import from Jotform** → review → **Publish**.

## Files

| File | |
|---|---|
| `ue-apply-form/index.html`, `editor.js` | the editor |
| `ue-apply-form/jotform-import.mjs` | live Jotform form → form schema |
| `ue-apply-form/form-kit.mjs`, `waiver-kit.mjs`, `waiver-ui.mjs`, `emails.mjs` | pinned copies from ue-apply/public |
| `netlify/functions/ue-apply-forms.mjs` | API |
| `MIGRATION-ue-apply.sql` | tables shared with ue-apply |
| `test/ue-apply-forms.test.mjs` | `npm run test:ue-apply-form` |
