# Form PDFs on HubSpot contacts

Every lead or applicant submission ends up as a **PDF attached to the HubSpot
contact**: a note on the contact's timeline with the PDF in its attachments.

| Submission | Where it comes from | When it's attached | Attached by |
|---|---|---|---|
| **Full application** | pd-apply, `applications.step2_at` | within 10 min | `student-payments-sync` (unchanged; STUDENT-PAYMENTS.md) |
| **Application started** (step 1 only) | pd-apply, `applications.step1_at` with no step 2 | after 30 min, if they haven't submitted the full application | `form-attachments-sync` |
| **Gap year quiz** | pd-apply `/quiz`, `quiz_responses` | within 5 min | `form-attachments-sync` |
| **Referral** | pd-apply `/refer`, `referrals` | within 5 min — **one note on both** the referred person and the referrer | `form-attachments-sync` |
| **Meta instant lead form** (Facebook / Instagram) | Graph API → `meta_leads` | within 5 min of HubSpot's Lead Ads sync creating the contact | `form-attachments-sync` |
| **Website popup** | `popup-submit` | immediately, on the popup's timeline note | `popup-submit` |

- **Never creates contacts.** pd-apply, Zapier/Make, the popup and HubSpot's
  Lead Ads sync create them, as before. If the contact isn't there yet (sync
  lag), the submission waits and is retried: 5, 10, 15 … minutes apart, capped
  at 6 hours, for up to 30 tries (about a week). Matching is by the stored
  contact id, otherwise by email (primary or additional email).
- **Backfill is automatic.** Newest first, 6 per kind per run, so new
  submissions land within minutes and older quizzes, referrals and step-1
  applications work backwards on their own. Meta: the first run takes the last
  89 days (Meta keeps leads for 90), or from `META_LEADS_START`.
- **Files** go to HubSpot Files (private) under `/Lead Forms/Quiz`,
  `/Lead Forms/Referrals`, `/Lead Forms/Applications Started`,
  `/Lead Forms/Meta Lead Forms` and `/Lead Forms/Website Popups`. Full
  applications stay in `/Student Applications`.
- Fields marked **Private** in the Apply Form editor are left out, same as the
  application PDF (`APPLICATION_PDF_INCLUDE_PRIVATE=true` includes them).
- Status and errors: the **Student Payments** dashboard has a new panel,
  "Quiz, referral, popup & Meta lead PDFs", with counts per kind, the ones
  still waiting and why, a Retry button, and **Attach now**.

## Setup

1. **Deploy.** The tables create themselves on the first run.
   (`MIGRATION-form-attachments.sql` is the same SQL, if you'd rather run it in
   Neon first.)
2. **HubSpot:** `HUBSPOT_TOKEN` needs the **`files`** scope (already required
   for application PDFs). If popups use their own `POPUP_HUBSPOT_TOKEN`, add
   `files` to that private app too.
3. **Meta lead forms** — env vars on the pd-dashboard site:

| Key | What |
|---|---|
| `META_PAGE_IDS` | The Facebook Page id(s) the lead forms run on, comma separated. Page → About → Page transparency, or Business Settings → Pages. |
| `META_LEADS_TOKEN` | A token that can read the Page's leads. Recommended: Business Settings → Users → **System users** → add (Admin) → **Assign assets** → the Page (full control) → **Generate new token** for an app in the business, never expiring, with `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `ads_read` (for the campaign and ad names). A long-lived Page access token works too. |
| `META_LEADS_START` | optional — earliest lead date for the first backfill, e.g. `2026-10-01`. |
| `META_GRAPH_VERSION` | optional, default `v21.0`. |

   Also in Business Settings → Integrations → **Leads Access**: if the Page
   restricts lead access, give the System User (or the app) access, or the
   Graph API returns an empty list. Without `META_LEADS_TOKEN`/`META_PAGE_IDS`
   the Meta part is skipped and everything else still runs.

4. Optional: `FORM_PDF_STEP1_DELAY_MIN` (default `30`) — how long a step-1-only
   application waits before its PDF is filed. `FORM_PDF_FOLDER` (default
   `/Lead Forms`) — the HubSpot Files folder root.

## Files

```
MIGRATION-form-attachments.sql                         meta_leads, form_attachment_state, *_pdf_* columns
netlify/functions/form-attachments-sync.mjs            scheduled */5
netlify/functions/form-attachments.mjs                 /api/form-attachments (status, run now, retry)
netlify/functions/_shared/form-attachments-run.mjs     one pass
netlify/functions/_shared/submission-pdf.mjs           the PDF layout + one builder per form
netlify/functions/_shared/meta-leads.mjs               Graph API reads
netlify/functions/_shared/popups-hubspot.mjs           popup PDF on the timeline note
netlify/functions/_shared/hubspot-student.mjs          + contactIdForEmail, notes on several contacts
netlify/functions/_shared/application-pdf.mjs          + applicationRows({ steps })
netlify/functions/_shared/student-payments-run.mjs     full apps without a contact id: matched by email
student-payments/index.html                            the status panel
test/form-attachments.test.mjs                         npm run test:form-attachments
```
