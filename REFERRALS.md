# Referral form

A separate form at **apply.pacificdiscovery.org/refer** for anyone to refer a
future student: past or current students, parents, counselors and partners,
and staff or instructors. It's edited, and its referrals are tracked, in the
dashboard at **Apply Form → Referral form** (`/apply-form/referral.html`). It
uses the same draft → publish → versions model as the application and the quiz.

## Set-up (dashboard)

1. Run `MIGRATION-referral.sql` in Neon. It's idempotent and creates the `referrals` table.
2. Open **Apply Form → Referral form → Set up the referral form**.
3. Go to **HubSpot → Set up HubSpot properties & association label**. This creates
   the `pd_referral*` contact properties and the contact↔contact label
   “Referred by” / “Referred”.
4. Go to **HubSpot → Create in HubSpot** to create the HubSpot form the referrer is submitted to.
5. Publish. Nothing shows on `/refer` until the pd-apply side (below) ships.

## What one referral does

| | Referrer | Referred person |
|---|---|---|
| HubSpot contact | created or updated | created or updated |
| How | **HubSpot form submission with the visitor cookie** (`hutk`), so Original Source is their real channel | **CRM API, no cookie**, so the referrer's browsing isn't credited to their friend |
| Properties | name, email, phone, `company_tag`, `pd_referrer_type`, `pd_referrals_made` (one line appended per referral), plus any field mapped on page 1 | name, email, phone, `company_tag`, `hs_lead_status` (setting), `pd_referred_by`, `pd_referred_by_email`, `pd_referrer_type`, `pd_referral_date`, `pd_referral_details` (every answer), the optional “how did you find us” property, plus any field mapped on page 2 |
| Never | overwrites lifecycle stage backwards, lead status, or owner | the same |

Then **referred → referrer** are associated with `settings.associationLabel`
(default “Referred by”). Each referral is one row in `referrals`.
`referralContacts(schema, values)` in `apply-form/referral-kit.mjs` builds
both property sets, so the dashboard and pd-apply can't drift.

## pd-apply side (still to build)

What pd-apply needs, and what the dashboard already expects:

- **Copy** `apply-form/referral-kit.mjs` to `pd-apply/public/referral-kit.mjs`.
  From then on, `npm run sync:form-kit` keeps the two copies in step.
- **`GET /refer`**: render the PUBLISHED `apply_forms` row `pd-referral` through
  `publicReferral()` and form-kit's `renderStep`, as two pages (`referrer`, then `friend`).
  - Prefill from the query string: `?type=` (a `referrerType` option), `?email=`, `?first=`, `?last=`.
  - `?preview=1` saves nothing and sends nothing.
  - Thank-you screen: `thanksTitle` and `thanksBody`. The `anotherLabel` button
    clears page 2 and keeps page 1.
- **`POST /api/referral`**:
  - Validate with `validateStep` (both steps) plus `referralErrors()`.
  - Add a honeypot and a rate limit per IP, as on the quiz.
  - Insert into `referrals`, then sync HubSpot as in the table above, recording
    `sync.{referrer, referred, association, form, email}` as `{ ok, error?, at }`.
  - Set `referred_existed` when the referred email was already in HubSpot.
  - Email `settings.notifyEmails` if it's set.
- **`POST /api/referral/resync`** `{ id, force }` with the `x-apply-key` header:
  re-run the HubSpot sync. The dashboard's **Resend** button calls this.
- Use the attribution kit on `/refer` exactly as on the quiz. It's stored on
  the row and describes the **referrer's** visit.
