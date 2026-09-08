# How every row on the Cash flow tab is calculated

Each row below gives the rule, then traces a real figure from the current
dashboard so you can check it yourself rather than take my word for it.

Figures shown are at a **planning rate of 1.65** (the "Pinned" option). At the
90-day average of 1.7126 every NZD figure is about 3.8% larger; the USD rows are
unaffected.

They also predate the real payment terms. Every traced figure below assumes a
**1,000 deposit due 60 days before departure**, which is how the model was
configured when this was written. The real terms are **2,500 and 90 days**. Once
those are entered each balance lump moves a month earlier — Fall to July, Spring
to November, Summer to April — and every figure below changes with them. The
*rules* stay exactly as described; only the inputs move.

**Nothing in this table comes from Xero.** Every row on the Cash flow tab is
computed from the assumptions you enter — programs, pax, payment rules,
overheads. Xero data appears only in the separate *Xero actuals* panel below the
table, and the two are never mixed. That separation is deliberate: it is what the
old workbook lost when expected and actual figures shared the same cells and had
to be reconciled by hand-entered adjustment rows.

Two conventions explain most of the confusion this model can otherwise cause:

- **The top block is in NZD.** Deposits, balances, cash in — all converted, so
  the column adds up.
- **The Treasury block is in native USD**, except the two rows that say NZD. The
  USD rows are the actual dollars in the actual account.

---

## Deposits in

Every student pays a deposit when they book. The booking curve says *when* they
book, as a share of the cohort landing each month before departure.

```
for each program, for each point on the booking curve:
    pax at this point = pax × share
    deposit cash      = pax at this point × deposit        (USD)
    Deposits in      += deposit cash × FX rate             (NZD)
    booked into: departure month − monthsBefore
```

**Apr 26 = 19,800.** Three seasons contribute, because April sits at a different
distance from each departure:

| Season | Departs | Months before | Curve share | Pax | USD |
|---|---|---|---|---|---|
| Fall | 1 Oct 26 | 6 | 14% | 51 | 7,140 |
| Spring | 5 Feb 27 | 10 | 6% | 60 | 3,600 |
| Summer | 1 Jul 26 | 3 | 9% | 14 | 1,260 |
| | | | | | **12,000** |

12,000 × 1.65 = **19,800**. And 12,000 is exactly what the `USD received` row
shows for April — same event, two currencies.

## Balances in

The rest of the price, due a fixed number of days before departure. Unlike
deposits, everyone pays on the same date regardless of when they booked, so it
lands as a single lump.

```
balance      = price − deposit                    (USD, per student)
balance month = departure date − 60 days
Balances in  += pax × balance × FX rate           (NZD)
```

**May 26 = 138,600.** Summer departs 1 Jul, minus 60 days = 2 May.
14 pax × (7,000 − 1,000) = 84,000 USD × 1.65 = **138,600**.

**Aug 26 = 1,220,175.** Fall departs 1 Oct, minus 60 days = 2 Aug.
51 pax × (15,500 − 1,000) = 739,500 USD × 1.65 = **1,220,175**.

**Dec 26 = 1,270,500.** Spring departs 5 Feb, minus 60 days = 7 Dec.
40 semester × 14,500 + 20 mini × 9,500 = 770,000 USD × 1.65 = **1,270,500**.

Those three lumps are why the cash line swings so hard.

## Cash in

`Deposits in + Balances in`. May: 20,015 + 138,600 = **158,615**.

## Program costs

```
total cost = fixed cost + (variable cost per pax × pax)     (NZD, no FX)
```

then spread by the cost phasing — currently 25% the month before departure,
45% in the departure month, 25% the month after, 5% the month after that.

Fall's total cost is 805,020 (the five Fall programs' fixed plus per-pax costs).
Departing 1 October, it phases:

| Month | Share | Fall | Plus | Row shows |
|---|---|---|---|---|
| Sep 26 | 25% | 201,255 | Summer's 5% tail, 9,954 | **211,209** |
| Oct 26 | 45% | 362,259 | — | **362,259** |
| Nov 26 | 25% | 201,255 | — | **201,255** |
| Dec 26 | 5% | 40,251 | — | **40,251** |

Spring's 709,396 phases the same way from 5 February: Jan 177,349 / Feb 319,228 /
Mar 177,349 — which is exactly what the row shows.

Note these are NZD and are **not** multiplied by the FX rate. Programs sell in
USD and pay suppliers in NZD, so price and cost convert independently.

## Overheads, Capital, Tax

**Not from Xero.** These are the twelve monthly figures you type on the
Overheads tab, used as entered with no calculation applied.

The seeded values came from the old workbook's own Overheads and Capital rows —
71,450 for April, 65,211 for May and so on. Whoever built that workbook
presumably derived them from past actuals at some point, but nothing refreshes
them. They are a number typed once a year.

Capital is a flat 10,999 every month, straight from the workbook. **Tax is zero
in every month — GST and PAYE are not in this model at all.** The row exists so
there is somewhere obvious to put them.

Overheads are the strongest candidate for coming from Xero later: a P&L for the
period would give real operating expenses per month, which would make this row
self-maintaining instead of an annual guess. Not built yet.

## Net movement

`Cash in − (Program costs + Overheads + Capital + Tax)`

Apr: 19,800 − (0 + 71,450 + 10,999 + 0) = **−62,649**.

This is the accounting view of the month. It is *not* what happens to your bank
accounts, because it says nothing about which currency the cash is in. That is
what the Treasury block is for.

---

# Treasury

Funds arrive in USD. Costs are paid in NZD. Conversion happens only when NZD
runs short, so these four rows track two real accounts rather than one notional
one.

## USD received

The same deposits and balances as above, in the currency they actually arrive
in. Apr = **12,000** USD, which × 1.65 gives the 19,800 in `Deposits in`.

## USD converted

Sized to the shortfall, never more:

```
after receipts and payments:
    if NZD balance < buffer and USD available:
        NZD needed  = buffer − NZD balance
        USD to sell = min(NZD needed ÷ rate, USD available)
```

**Apr:** opening NZD −501,125, less 82,449 of costs = −583,574. To reach the
50,000 buffer needs 633,574 NZD, or 384,590 USD. Only 12,000 USD exists, so it
converts all of it and stays short. **The shortfall is left visible** — it is not
floored at the buffer.

**Aug:** 750,450 USD arrives, only 545,097 is converted, 205,353 stays in USD.
That is the buffer being satisfied with room to spare.

## USD balance

Running USD, after receipts and conversion. Aug: 0 + 750,450 − 545,097 =
**205,353**. Sitting unconverted, carrying rate risk — this is the number the
sensitivity panel moves.

## NZD from conversion

`USD converted × rate`. Aug: 545,097 × 1.65 = **899,410**.

## NZD account

The one that answers "can we pay this supplier".

```
NZD account = previous + NZD receipts − all NZD costs + NZD from conversion
```

**Apr:** −501,125 − 82,449 + 19,800 = **−563,774**.
**Aug:** −732,152 − 117,258 + 899,410 = **50,000** — pinned exactly at the buffer,
because conversion was sized to land there.

Months reading exactly 50,000 are months where USD was available. Months below it
(Feb −59,101, Mar −301,010) are months where everything convertible was already
converted.

## Total position (NZD)

`NZD account + (USD balance × rate)`. Aug: 50,000 + 205,353 × 1.65 = **388,832**.

Mark-to-market, not spendable. It values USD you have not sold at a rate you have
not achieved. Useful for "how covered are we", useless for "can we pay this
invoice on Tuesday".

---

# The accounting rows

## Revenue recognised

The whole of a season's revenue lands in one month — the month before the season
starts — regardless of when the cash arrived.

| Season | Recognised | Calculation | Row shows |
|---|---|---|---|
| Summer | Jun 26 | 14 × 7,000 × 1.65 | **161,700** |
| Fall | Sep 26 | 51 × 15,500 × 1.65 | **1,304,325** |
| Spring | Jan 27 | (40 × 15,500 + 20 × 10,500) × 1.65 | **1,369,500** |

## Deferred revenue

Cash collected but not yet recognised. Rises with every receipt, drops to zero
when its season recognises.

```
Deferred = previous + cash in (NZD) − revenue recognised
```

**Apr 26 = 85,751**, which is 65,951 opening plus April's 19,800. That opening is
real: 39,970 USD of deposits were collected *before* 1 April for programs
departing inside this year — Fall bookings from October 2025 onward, Summer
bookings from July 2025. × 1.65 = 65,951.

**This row is the model's own self-check.** It should climb as cash lands and
return to zero in each recognition month. Dec 26 peaks at 1,366,530, then January
recognises 1,369,500 and it returns to zero. If it ever goes negative or fails to
clear, an input is wrong — most likely a departure date or a recognition month.
The old workbook had no equivalent signal.

---

# What these numbers are not

- **Feb and Mar 27 show no cash in at all.** The model only holds FY26/27
  programs, and the last booking for a February departure lands in January. In
  reality you would be selling Fall 2027 through those months. **The last two
  months of the forecast are understated** until next season's programs are added.
- **Per-program pax, departure dates and cost phasing are placeholders.** The
  July trough moves with all three.
- **No GST, no PAYE.** The Tax row is structurally present and numerically empty.
- **No refunds or withdrawals.** Every forecast student is assumed to pay in full.
