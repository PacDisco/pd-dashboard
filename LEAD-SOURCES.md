# Lead Sources + Gap Year Quiz

**Lead Sources** (`/lead-sources/`) shows where leads really came from: HubSpot's
Original Source next to the source captured by pd-apply (quiz + application),
with “Offline Sources” records recovered from the drill-downs using the same
rules as the Sales Funnel (`recoverOffline` in `sales-funnel-data.mjs`).
Each lead's real source is picked by `realSource()` in `attribution-kit.mjs`:
HubSpot (if not Offline/Direct) → site first visit → recovered drill-down → HubSpot
Direct → Unknown. Parents created from applications are hidden by default.

**Quiz editor** (`/apply-form/quiz.html`, linked from the Apply Form header) edits
the quiz at apply.pacificdiscovery.org/quiz — questions, which results each answer
scores for, result texts, HubSpot form — and lists responses. Same draft/publish/
versions model as the application (row `pd-quiz` in `apply_forms`, via
`/api/apply-forms?form=quiz`).

## Setup
1. Run `MIGRATION-quiz.sql` in Neon.
2. Lead Sources → *Setup* → **Set up HubSpot properties** (needs the
   `crm.schemas.contacts.write` scope on `HUBSPOT_TOKEN`).
3. Quiz → Settings & HubSpot and Apply Form → Fee, interview & text:
   **Create in HubSpot** (needs the `forms` scope, or create a form with an Email
   field by hand and paste its ID). Publish both.
4. Add `<script src="https://apply.pacificdiscovery.org/attribution.js" async></script>`
   to every page of www.pacificdiscovery.org.
5. Turn off the Zaps / Make scenarios that create contacts from the Jotform quiz
   and step 1.

Shared modules are pinned copies from pd-apply — keep them in step with
`npm run sync:form-kit -- ../pd-apply` (form-kit, quiz-kit, attribution-kit).
Tests: `npm run test:quiz-leads`, `npm run test:quiz-leads-ui`.
