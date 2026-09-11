# Rebuild from the FY26/27 P&L

What the real Profit and Loss for the five months ended 31 August 2026 changed,
and what is now driven by it rather than by the workbook.

## The comparison that started it

Apr–Aug 2026, dashboard against the books:

| | Dashboard | Xero P&L | Gap |
|---|---|---|---|
| Revenue recognised | 0 | 1,219,631 | −1,219,631 |
| Program costs | 230,407 | 316,915 | −86,508 |
| Overheads + capital | 376,873 | 407,006 | −30,133 |

The first is a bug, now fixed. The second is a wrong model, now measurable. The
third is smaller than it looks — see below.

## 1. Fall recognises in August — fixed

The books put 1,081,772 of Sales Income in **Aug 2026**. The model had Fall's
recognition month set to September, on the assumption the season departs in
October. It departs 1 September, so the month before is August.

Because `recognitionMonthFor` searched for the most recent September *before*
departure, it matched **September 2025** — outside the fiscal year. The season's
revenue left the year entirely and `deferredOpening` subtracted the whole cohort
to compensate, which is why deferred revenue read −1,127,826 in April.

Summer (June, 138,524) and Spring (January) were already right. One constant was
wrong.

Recognition months are now **editable on the Overheads tab** and validated on
save. Previously they existed only in the seed, so a wrong value could not be
corrected without re-seeding — an unreasonable place to keep something that can
move a season's revenue out of the year.

## 2. Overheads from the P&L — and a correction to my own figure

I said the model was 7.4% light on overheads. That compared against raw P&L
operating expenses, which contain two large non-cash lines:

| Month | P&L opex | Non-cash | Cash opex | Model | Model vs cash |
|---|---|---|---|---|---|
| Apr | 94,093 | 12,478 | 81,615 | 82,449 | +834 |
| May | 63,733 | 9,603 | 54,130 | 76,210 | **+22,080** |
| Jun | 72,856 | −33,805 | 106,661 | 67,710 | **−38,951** |
| Jul | 93,956 | 30,920 | 63,036 | 83,017 | +19,981 |
| Aug | 82,369 | −439 | 82,808 | 67,487 | −15,321 |
| **Total** | 407,006 | 18,756 | **388,250** | 376,873 | **−11,377** |

Against cash-like opex the model is **2.9% light over five months, not 7.4%** —
but the monthly shape is badly wrong, and for a cash forecast the shape is the
part that matters.

Bank Revaluations and Unrealised Currency Gains swing by tens of thousands a
month in both directions as the USD balance is remeasured. June's reported opex
is 33,805 *cheaper* than the month really cost, purely because the dollar moved.
Feeding that into a cash forecast imports noise, so `cash-opex.mjs` excludes
them by name — a short explicit list, because a clever pattern that quietly
dropped Bank Fees (6,454 a year) or overdraft interest (21,984 a year) would be
invisible.

Check it against a month you can open side by side:

```
GET /api/cash-xero-probe?month=2026-06&report=opex
```

Uses `accounting.reports.profitandloss.read`, already consented. June is the
month worth checking — if the parser is wrong about non-cash lines, June is where
it shows.

## 3. Cost phasing — measured, not replaced

The model spreads program cost 25% the month before departure, 45% in it, 25%
after, 5% after that. Your books show 316,915 already incurred by 31 August for a
season departing 1 September, while the model says **zero until August**. Real
supplier spend starts at least five months out, not one.

I have not replaced the curve with another invented one. `cash-phasing.mjs`
derives it from per-program monthly costs in the tracked P&L, lined up against
each program's own departure date — and **reports its own coverage rather than
presenting a partial curve as fact**. On the current data it returns:

- the observed shape, −5 through −1 months
- coverage of about 34% of expected program cost
- `adoptable: false`, because one partly-spent season with nothing after
  departure is not a curve

A derived number carries more authority than a guessed one, so a half-observed
season presented as measured truth would be worse than the guess it replaces.
The curve becomes adoptable once a season has been through its full cycle.

This depends on program tracking existing in Xero — the same open question the
receipts probe answers.

## 4. Still outstanding, and now quantified

- **Summer is missing from the model.** The books recognised 138,524 in June;
  the dashboard shows nothing, so those programs have no pax.
- **The overdraft is real and unmodelled.** Bank Overdraft Interest runs 21,984
  year to date, falling from 6,483 in April to 976 in August. The deep negative
  NZD balances are financed, not a modelling artefact — but the facility cost
  appears nowhere in the forecast.
- **Program costs are accrual in the P&L, cash in the model.** A supplier invoice
  hits the P&L when raised, not when paid. Close on short payment terms, worth
  knowing when the two disagree.
- **Capital is a flat 10,999 a month**, straight from the workbook, and capex
  does not appear in a P&L, so nothing here verifies it.

## 5. The thing the P&L settles

Net profit for the five months is **507,397** against a bank position around
−500,000. That is not a contradiction — it is what deferred revenue does to a
business that collects long before it delivers. The dashboard is the only place
those two views sit beside each other, which is the argument for getting the
recognition side exactly right.
