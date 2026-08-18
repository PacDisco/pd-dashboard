# T-Shirt Size & Shopify Ordering — Enrollment Dashboard

Adds a **Shirt Size** column and an **Order T-Shirt** button to
`/enrollment`. The button opens a popup pre-filled with the size and home
address the student gave on their application, and on submit creates a real,
paid order in the Pure Exploration Shopify store and logs a note on the
student's HubSpot deal.

---

## Before it will work: two things to set up

Everything else is already wired. These two are external and can only be done
by a human with the right logins.

### 1. Create a Shopify custom app and add its token to Netlify

In Shopify admin (`pure-exploration.myshopify.com`) → **Settings → Apps and
sales channels → Develop apps → Create an app**. Give it the Admin API scopes:

| Scope | Why |
|---|---|
| `write_orders` | create the order |
| `read_orders` | find existing orders for the "Ordered" badge |
| `read_products` | read the shirt's variants and live stock |
| `write_customers` | attach the student as the order's customer |

Install the app, reveal the **Admin API access token** (`shpat_…`), then in
Netlify → **Site configuration → Environment variables** add:

```
SHOPIFY_ADMIN_TOKEN = shpat_xxxxxxxxxxxxxxxxxxxxx
```

That single variable is the only required one. These are optional and only
needed if something changes:

| Variable | Default | When to set it |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | `pure-exploration.myshopify.com` | You move stores |
| `SHOPIFY_API_VERSION` | `2026-04` | Shopify deprecates that version |
| `SHOPIFY_TSHIRT_PRODUCT_ID` | `gid://shopify/Product/9345666973947` | You replace the Pacific Discovery T-Shirt product |
| `SHIRT_ORDER_ROLES` | `admin,operations,programs,admissions` | You want to narrow who can order |

`HUBSPOT_TOKEN`, `JOTFORM_API_KEY` and `URL` are already set on this site and
are reused as-is.

### 2. Confirm extended function timeouts

`netlify.toml` now requests `timeout = 26` for `enrollment` and `shirt-orders`,
the same as the existing `flight-tickets` entry. Netlify only honours >10s once
support has activated extended timeouts for the site. If enrollment starts
timing out on cold starts, that's the thing to chase — the code degrades
gracefully either way (see "If Jotform is down" below).

---

## Where the shirt size comes from

The application form asks **"Please choose your t-shirt size"**. All 391
submissions have answered it, so coverage is not the constraint — but the same
answer exists in three places with three different vocabularies, and they
disagree. Resolution order, most trustworthy first:

1. **The Jotform application**, matched on a participant email belonging to one
   of the deal's associated contacts. This is what the student typed.
2. **The Jotform application**, matched on the student's name — covers the ~7
   submissions with no email and the handful with typos (`…@gmail.con`).
3. **`t_shirt_size_` on an associated HubSpot contact.**
4. **`pd_t_shirt_size` on the deal.**

Sizes from (1) and (2) show as a plain indigo badge. Sizes from (3) or (4) show
a yellow badge with a `?`, because they are not the student's own answer —
Emma Lyons is the worked example: her own contact record is blank while her
mother Hannah's says "Large", and Emma actually answered "Medium". Hover any
badge for its provenance.

### Size vocabulary mapping

| Application answer | Shopify variant |
|---|---|
| X-small | XS |
| Small | S |
| Medium | M |
| Large | L |
| X-large | XL |
| **XX-large** | **2XL** |

`XX-large` is a real answer (4 students, including Rachel Stern) that a naive
five-size mapping would drop. `normalizeShirtSize()` also accepts `XXL`, `2XL`,
`3XL`, `xlarge`, `x large`, `Medium (38-40)` and similar.

### Re-applications

About 25 people applied more than once, and several gave a **different size
each time** (Medium, then Large). The newest submission wins, decided by
comparing timestamps rather than trusting the Jotform API's sort order.

### Namesakes

If two different email addresses both claim the same name, that name is
excluded from name-matching entirely rather than guessed — better a blank cell
than the wrong shirt to the wrong student.

---

## Where the shipping address comes from

1. The application's **"What is your home address"** answer (structured:
   street, city, state, postcode, country).
2. The contact's `mailing_*` group in HubSpot.
3. The contact's standard `address`/`city`/`state`/`zip`/`country` group.

HubSpot's `address` field is very often the literal string `", "` — junk from a
form that concatenated two empty subfields. That is treated as empty.

Shopify's `MailingAddressInput` requires **ISO country codes** and
**province codes**, not free text, so `_shared/shirt.js` maps names to codes and
handles the real-world messes: `USA`, `Uk`, `England`, `nz`, and values with the
postcode glued on (`CT 06412` → `CT`). Anything it cannot resolve — HubSpot has
a country literally spelled `United Chated` — comes back empty and the popup
makes you pick from a dropdown before it will submit.

**Every field stays editable in the popup.** Nothing is submitted to Shopify
without a human seeing it.

---

## What happens when you click "Place order in Shopify"

1. Client-side validation (size, quantity, street, city, country, province).
2. `POST /api/shirt-orders`, which re-validates server-side and refuses
   anything the client let through.
3. Live stock check — 3XL currently has 0 on hand, so it's disabled in the
   dropdown and refused server-side with the actual number remaining.
4. `orderCreate` with `financialStatus: PAID`, no shipping line (free), tagged
   `pd-shirt` and `pd-deal-<dealId>`, with the student, deal id and your email
   as order attributes so whoever packs the box knows who it's for.
5. A note on the HubSpot deal: size, quantity, order number and link, where it
   shipped, who ordered it.
6. The row flips to a green **✓ Ordered** badge linking to the Shopify order.

**Order confirmation emails are off by default.** The student didn't buy this,
so a receipt would confuse them. There's a checkbox if you want one.

The note in step 5 is best-effort and deliberately non-fatal: by the time it
runs the shirt is already ordered, so if HubSpot hiccups you get the order plus
a warning, never an error that would tempt you into double-ordering.

---

## The Ordered badge

Read live from Shopify by querying orders tagged `pd-shirt` and fanning them
back out by their `pd-deal-<id>` tag — not tracked locally. So if someone
cancels or edits an order in the Shopify admin, the dashboard tells the truth
on the next load. Opening the popup for a student who already has one shows a
warning naming the existing order before you can add a second.

The order scan is capped at 20 pages (2,000 orders). If that's ever hit it logs
a warning rather than silently pretending the older orders don't exist.

---

## If Jotform is down

The dashboard still loads. Sizes fall back to HubSpot, the subtitle says
`⚠ Jotform application lookup unavailable — shirt sizes shown from HubSpot
only`, and the badges show as unverified. The parsed application index is cached
for 10 minutes in the warm container, so the steady-state cost of this feature
on `/api/enrollment` is nil.

## If Shopify is down

The Shirt Size column still works — it's HubSpot + Jotform only. The T-Shirt
column falls back to plain "Order T-Shirt" buttons, and clicking one explains
that Shopify isn't reachable instead of failing on submit.

---

## Authorisation — read before touching `shirt-orders.mjs`

`/api/*` is **not** covered by the site's `Role=` redirects, and
`auth-gate.js` explicitly excludes `/api/*`. The check inside
`shirt-orders.mjs` is the only thing in front of an endpoint that spends money
and ships goods.

It therefore **verifies** the Netlify Identity token against GoTrue rather than
decoding it, exactly like `jotform-file.mjs`. Decoding alone is safe at the edge
only because Netlify's CDN has already signature-checked `nf_jwt` upstream of
`auth-gate`. There is no such rule here, so an unverified decode would let
anyone forge an admin cookie and post orders. Don't downgrade it.

Reading (`GET`) needs any dashboard role. Ordering (`POST`) needs one of
`SHIRT_ORDER_ROLES`.

---

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/shirt.js` | **New.** Size vocabulary + country/province code mapping + address shaping. Shared by both functions. |
| `netlify/functions/shirt-orders.mjs` | **New.** `GET` existing orders + variants, `POST` create order and log the note. |
| `netlify/functions/enrollment.js` | Reads the Jotform application, adds `shirtSize`, `shirtSizeSource`, `shippingAddress` and the picklists to the payload. Additive only — the Flights dashboard consumes this same endpoint and is unaffected. |
| `enrollment/index.html` | Shirt Size column, T-Shirt column, order popup, Ordered badge. Column sorting now keyed off `data-sort` instead of column index, so the money columns can't silently break again. |
| `netlify.toml` | `timeout = 26` for `enrollment` and `shirt-orders`. |
| `test/enrollment-shirt.test.mjs` | **New.** 17 assertions on the server-side resolution rules, with both upstreams stubbed. |
| `test/shirt-order.smoke.mjs` | **New.** 31 assertions driving the real page in headless Chromium. |

## Tests

```bash
npm run test:shirt      # server-side resolution rules (no network)
npm run test:shirt-ui   # full page in headless Chromium (needs playwright)
```

Both pass. `test:shirt-ui` skips cleanly with a message if Playwright isn't
installed.
