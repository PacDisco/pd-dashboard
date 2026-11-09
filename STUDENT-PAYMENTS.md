# Student Payments + Application PDFs

Runs for **Pacific Discovery** and **Unearthed Education**. Each brand has its own Stripe account, its own Wise account, its own deal pipelines and its **own dashboard**:

- **Student Payments** (`/student-payments/`, roles admin · operations · admissions): Pacific Discovery only, plus the application and lead-form PDFs.
- **Unearthed Student Payments** (`/ue-student-payments/`, roles admin · operations · unearthed): Unearthed only, plus watch mode and deal stages.

A payment is only ever matched to a deal of the brand whose account received it. Each dashboard's API only returns, assigns, ignores or requeues its own brand's payments. Both run on one 10-minute sync. Unearthed's setup is below in **Unearthed Education**.

Every 10 minutes, `student-payments-sync` does three things:

1. **Pulls new payments** from Stripe (succeeded charges) and Wise (incoming bank deposits on every balance) from the last 3 days. Each payment becomes a row in `deal_payments`. If the same payment is read twice, it's only stored once.
2. **Logs them against the HubSpot student deal** in USD. It writes the next empty `payment_N` (1–15) as `amount, reference, YYYY-MM-DD` (the same format already used on deals) and updates `total_amount_paid`. Payments it can't place go to the review queue on the **Student Payments** dashboard. It never writes to HubSpot on a guess.
3. **Attaches application PDFs**. Every full application from apply.pacificdiscovery.org gets a PDF, added as a note on the contact and deal. If pd-apply never stored a contact id on the application, the contact is found by email (retried hourly until it exists). It does up to 5 per run, oldest first, so existing applications backfill on their own. If the deal is created later (when the fee is paid), the note gets linked to it.

Quizzes, referrals, step-1-only applications, website popups and Meta lead forms get PDFs too — see **FORM-ATTACHMENTS.md**.

All environment variables go on the **pd-dashboard** Netlify site.

## Setup

1. Run `MIGRATION-student-payments.sql` in the Neon SQL editor (after `MIGRATION-apply.sql`), then `MIGRATION-student-payments-brands.sql`.
2. Environment variables:

| Key | Needed | What |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | already set | The private app needs these scopes: **`files`**, `crm.objects.deals.read/write`, `crm.objects.contacts.read/write`. Add `files` if it's missing, or PDF uploads will fail with 403. |
| `STRIPE_SECRET_KEY` | already set | Used when `STUDENT_PAYMENTS_STRIPE_KEYS` isn't set. |
| `STUDENT_PAYMENTS_STRIPE_KEYS` | optional | `pd:rk_live_…,pe:rk_live_…` to watch more than one Stripe account. A restricted key with read access to Charges, PaymentIntents and Customers is enough. |
| `WISE_API_TOKEN` | for Wise | Wise → Settings → API tokens → **Read only**. |
| `WISE_PROFILE_ID` | optional | Found automatically from the token. Only set it if the token can see more than one business profile (the dashboard error lists their ids). |
| `STUDENT_PAYMENTS_START` | recommended | Go-live date, e.g. `2026-10-23`. Payments before it are never picked up. |
| `STRIPE_CARD_FEE_RATE` | optional, default `0.035` | The card surcharge to strip off (explained below). Set to `0` to credit charges as charged. |
| `WISE_ADD_BACK_FEES` | optional, default on | Wise reports deposits net of its receiving fee. By default the fee is added back, so the deal is credited what the family sent. `false` credits the net amount. |
| `STUDENT_PAYMENT_PIPELINES` | optional | Comma-separated deal pipeline ids that name and email matching searches. Defaults to the five pipelines the Enrollment dashboard shows. Add the Pure Exploration pipeline here if its payments should match too. |
| `APPLICATION_PDF_INCLUDE_PRIVATE` | optional | `true` includes fields marked Private (health, passport, criminal record) in the PDF. They're left out by default. |

3. Deploy. The dashboard tile appears automatically. Press **Sync now** once to check that Stripe, Wise and HubSpot all connect. Any error shows at the top of the page.

## How a payment finds its deal (first match wins)

0. The payment's reference is already in a slot on a student deal. It's marked "Already on deal" and nothing is written. This covers the app fee pd-apply logs itself, and hand entries that used the reference.
1. Stripe metadata `hubspot_deal_id` / `deal_id`.
2. A deal id typed into the reference (`PD-65383262849 Grace Gragg`). If the reference also names a student, the name has to match that deal. If the ID points to one student and the name to another (a parent paying for two kids who swapped the IDs), the payment goes to review with both deals offered. A reference with only an ID, or only a parent's name, is matched on the ID.
3. The payer's email → contact → their open student deal. If several, the one still owing.
4. The student's first **and** last name in the reference or payer name, matched against open student deals.
5. The payer's name is a contact on exactly one open student deal (usually a parent). This is the main route for ACH, where banks often drop the reference. Bank account-holder names are cleaned up first: middle initials, titles and suffixes are dropped, case is ignored, `SMITH, ROBERT J` is read surname-first, and joint accounts (`ROBERT & JANE SMITH`, `ROBERT OR JANE SMITH`) try each parent. Contacts are compared word by word, so `Robert James / Smith` and `Maria / Garcia Lopez` fit. Nicknames aren't guessed: Rob ≠ Robert. If more than 5 contacts fit, the name is too common to count as evidence. **For this to work, parents need to be contacts associated with the student's deal, under their full legal names.**
6. Otherwise it goes to the review queue, with the deals that came close.

Before writing anything, it re-reads the deal and skips the payment if it's already there. That means the same reference, or the same amount within 3 days (a hand entry from the bank feed).

Payments are only processed once they're 15 minutes old, so pd-apply has time to write the app fee first.

**To make matching automatic from now on:** put `hubspot_deal_id` in the metadata of every Stripe payment link or checkout, and ask families to use `PD-<deal id>` as their Wise or bank reference.

## Amounts

- **USD** payments are credited as received.
- **Other currencies** are converted at that day's ECB reference rate (Frankfurter). The slot gets a 4th part, e.g. `…, NZD 4000.00 @ 0.5709`. That's a mid-market rate, not what Wise actually converted at.
- **Card surcharge:** if a Stripe charge divided by 1.035 comes out to a whole dollar amount, the surcharge is assumed and stripped. So $258.75 is credited as $250 and $2,328.75 as $2,250. Any other amount is credited as charged.
- **Refunds** aren't written back. A charge refunded in full before it was logged is marked Ignored.
- **Two equal payments a few days apart** (e.g. two $1,750 instalments) are both logged. The "same amount within 3 days" duplicate check skips slots that name a different Stripe payment (`pi_…`/`ch_…`), so it only catches hand entries made from the bank feed.

## Unearthed Education

Same sync, separate dashboard: **Unearthed Student Payments**. What's different:

| | Pacific Discovery | Unearthed Education |
| --- | --- | --- |
| Stripe | `STUDENT_PAYMENTS_STRIPE_KEYS` or `STRIPE_SECRET_KEY` | `UE_STUDENT_PAYMENTS_STRIPE_KEYS`, else `STRIPE_SECRET_KEY_UNEARTHED` (already set for the UE Stripe dashboard) |
| Wise | `WISE_API_TOKEN` (+ `WISE_PROFILE_ID`) | `UE_WISE_API_TOKEN` (+ `UE_WISE_PROFILE_ID`) — Unearthed's own Wise business account |
| Deals matched | `STUDENT_PAYMENT_PIPELINES` | `UE_STUDENT_PAYMENT_PIPELINES`, default `836668844` ("Unearthed Education") |
| Deal ids from Stripe / references | accepted from any pipeline | only deals in the UE student pipeline; anything else goes to review |
| Picking a deal by hand | any deal | only UE student deals — a deal in another pipeline has to be moved in HubSpot first |
| Card fee stripped | `STRIPE_CARD_FEE_RATE`, 3.5% | `UE_STRIPE_CARD_FEE_RATE`, 3%. Portal checkouts send `base_amount`, which is used first |
| Currency on the deal | converted to USD (ECB rate) | **as received** — an NZD payment is logged as NZD (`1750, pi_…, date, NZD 1750.00`), because UE deals and the portal's payment schedule are in the trip's currency. A payment in a different currency from the deal's goes to review |
| Go-live date | `STUDENT_PAYMENTS_START` | `UE_STUDENT_PAYMENTS_START` |
| Mode | live | `UE_STUDENT_PAYMENTS_MODE`: `watch` (default), `live` or `off` |
| Deal stages | not touched (pd-apply moves PD stages) | moved by the sync — see below |

**Watch mode.** Until `UE_STUDENT_PAYMENTS_MODE=live`, Unearthed payments are read and matched, and the **Watch mode** tab shows what *would* happen: which deal, which `payment_N`, the new total and any stage move. Nothing is written to HubSpot. Check those against what's been logged by hand, then set the variable to `live` and redeploy. The watch rows are processed for real on the next sync (anything already typed in by hand is recognised and not doubled).

**Stage moves** (pipeline "Unearthed Education": Application Complete → Deposit Paid → Closed Won):

- Total paid ≥ the trip's deposit → **Deposit Paid**. The deposit is `payment_amount_1` on the trip (Portal) record the deal is associated with, else on the global defaults record. If neither is set, any payment counts.
- Total paid ≥ the deal amount → **Closed Won**. Deals with no amount never close automatically.
- Only forward. Never out of Closed Won / Closed Lost, never into Closed Lost.
- Checked whenever a payment is logged to the deal, or found already on it.
- **Check stages** on the Unearthed dashboard lists open UE deals whose stage is behind what's been paid (e.g. paid by hand before this existed). An admin can then press **Move these deals**.

**From the application site.** Deposits paid at apply.unearthededucation.org carry `hubspot_deal_id` and `base_amount` too, so they log to the right deal without the card fee and move it to Deposit Paid.

**From the UE portal.** Checkouts started in the Unearthed portal now carry `hubspot_deal_id`, so they match the exact deal. If that deal isn't in the UE student pipeline (e.g. a student deal created in "UE School Expeditions"), the payment waits in review rather than being written there.

**Schools paying directly** (trips with "school collecting payments" ticked) won't match a student and will land in review. Mark them "Not a student payment".

**Access.** The tile appears under Unearthed for the roles admin, operations and unearthed. Change them in `ue-student-payments/dashboard.json` (and `ALLOWED_ROLES` in `netlify/functions/ue-student-payments.mjs`), or per person in dashboard permissions.

## Wise and strong customer authentication

Some Wise profiles need a signed request (SCA) to read balance statements. If yours does, the dashboard shows "Wise asked for strong customer authentication…". Wise's fix is an RSA key pair uploaded to the API token. That isn't built yet, so let Jake know if you see the message.

## Files

```
MIGRATION-student-payments.sql
netlify/functions/student-payments.mjs              PD dashboard API (locked to brand pd)
netlify/functions/ue-student-payments.mjs           Unearthed dashboard API (locked to brand ue)
netlify/functions/_shared/student-payments-api.mjs  the routes both share
netlify/functions/student-payments-sync.mjs         scheduled every 10 min
netlify/functions/_shared/student-payments-run.mjs  one sync pass (shared), per brand
netlify/functions/_shared/payment-brands.mjs        which brands run, and each one's accounts / pipelines
netlify/functions/_shared/deal-stages.mjs           UE stage rules (pure)
MIGRATION-student-payments-brands.sql               brand column, watch status, stage_move
netlify/functions/_shared/deal-payments.mjs         matching + slot rules (pure)
netlify/functions/_shared/payment-sources.mjs       Stripe / Wise / FX reads
netlify/functions/_shared/hubspot-student.mjs       HubSpot deals, contacts, files, notes
netlify/functions/_shared/application-pdf.mjs       application → PDF
student-payments/index.html, dashboard.json         the PD dashboard
ue-student-payments/index.html, dashboard.json      the Unearthed dashboard
assets/student-payments.js, .css                    page script + styles both share
test/student-payments.test.mjs                      npm run test:student-payments
```
