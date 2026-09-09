# Receivable receipts — money students actually paid

Status: **probe stage.** The puller and its tests are written; nothing is wired
into the dashboard yet, on purpose. One question can't be answered from
documentation — whether Pacific Discovery's student invoices carry a program
tracking option, and what those options are named — and guessing produces a
table where every figure lands in "Unattributed" with no way to tell whether the
parser is wrong or the bookkeeping is simply different.

So: re-consent, run the probe against one real month, and wire it in once the
output is right.

## Why not the Bank Summary we already pull

The Bank Summary gives four numbers per account — opening, received, spent,
closing. "Received" is every credit that hit the account: student payments, a
currency conversion landing from the USD account, interest, a reversed refund.
It can't say which of those was a student paying an invoice, which is the number
the forecast is trying to predict.

Receipts read the AR payments directly. Each payment names the invoice it
settled; the invoice's line items carry the program tracking option; the program
maps to a season. That gives a real *received from students, by season* figure
to set against the forecast's `Deposits in` + `Balances in`.

## Step 1 — scopes, which means re-consent

`SCOPES` in `_shared/cash-xero.mjs` changed:

```
+ accounting.payments.read      # the Payments endpoint
- accounting.banktransactions.read   # was never read by anything
```

`accounting.invoices.read` was already there and is now actually used.

Scopes are requested in the authorize URL at runtime, so there is nothing to
tick in the Xero portal — but a token issued under the old scope set will get a
**403** on `Payments`. You have to re-consent:

1. Set `XERO_SETUP_KEY` in Netlify to a fresh random value (generate it
   yourself — `openssl rand -hex 24` — don't paste it into this chat).
2. Deploy.
3. Visit `/.netlify/functions/cash-xero-auth?key=...` and approve.
4. Delete `XERO_SETUP_KEY` again. The endpoint fails closed without it.

A 403 mentioning scope after this means step 3 didn't take.

## Step 2 — run the probe

```
GET /api/cash-xero-probe?month=2026-08
```

Admin/operations only. Read-only, changes nothing, touches no stored blob. Pick
a month with real student payments in it — a balance-due month is the best test.

### What good output looks like

```jsonc
{
  "paymentsFound": 63,
  "paymentsTruncated": false,
  "invoiceIdsOnPayments": 63,
  "invoicesReturned": 61,
  "total": 1204880,
  "bySeason": { "Fall": 1180400, "Summer": 24480 },
  "unattributed": 0,
  "diagnostics": {
    "trackingOptionsSeen": [
      { "label": "Program: CAS", "payments": 21, "matched": true },
      { "label": "Program: NZA", "payments": 18, "matched": true }
    ],
    "accountCodesSeen": [{ "code": "200", "lines": 63 }],
    "invoicesNotReturned": []
  }
}
```

### What each failure mode means

| Symptom | Cause | Fix |
|---|---|---|
| `unattributed` is the whole total, `trackingOptionsSeen` empty | Invoices carry no tracking at all | Attribute by account code instead, or add tracking in Xero |
| Options listed with `matched: false` | Xero's names differ from the program names in the model | Set `xeroTrackingOption` on each program to Xero's exact spelling |
| `invoicesReturned` < `invoiceIdsOnPayments` | Some invoices weren't returned by the batch fetch | Check `invoicesNotReturned` — usually voided or deleted |
| `paymentsTruncated: true` | More than 2,000 payments in the month | Raise `maxPages`; the month is understated until you do |
| 403 mentioning scope | Re-consent didn't happen | Step 1 |
| `bySeason` has a season the model doesn't use | A program's season is set wrong in the model | Programs tab |

The probe returns **field names, not values**, for the sample payment and
invoice — enough to confirm the parser is reading the right fields, without a
diagnostic endpoint accumulating student names and invoice references.

## Step 3 — wire it in

Once the probe reads clean, receipts join the monthly blob the close feature
already uses, and the Cash flow table gains, for closed months only:

```
Received — Fall        real
Received — Spring      real
Received — Summer      real
Received — unattributed  real, and loud if non-zero
```

set against the existing forecast `Deposits in` + `Balances in`. Cash in stays
the bank figure; these rows explain the student portion of it.

## Cost

One Payments page per 100 payments, one Invoices call per 40 invoice ids.
A 63-payment month is 1 + 2 = 3 calls, fetched once and then cached like the
bank months. Against a 1,000/day/org limit this is not material.

## Known limits

- **Deposit vs balance isn't split, by decision.** With one part-paid invoice
  per student, nothing on a payment says which instalment it was, and it does
  not need to: deposit and balance timing stay a *forecasting* construct. The
  actuals side reports one figure per season, and the forecast now offers the
  same shape to meet it (`receiptsBySeason` on every month, reconciling exactly
  to `cashIn`). Comparing them tests the booking curve and the payment terms
  together, which is the thing worth knowing.
- **Refunds and reversals** aren't netted off. `ACCRECPAYMENT` only.
- **Credit notes applied to invoices** aren't cash and don't appear here, which
  is right for a cash figure but means receipts won't tie to a revenue report.
