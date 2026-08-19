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

### 1. Connect Shopify

There are two credential styles, and which you have depends on where the app
was created. The code supports both.

**A. App created in the Shopify Dev Dashboard** (its Settings → Credentials page
shows a **Client ID** and a **Secret**, with no permanent token). This is the
path Shopify now steers own-store apps toward. In Netlify → **Site
configuration → Environment variables** add:

```
SHOPIFY_CLIENT_ID     = <Client ID>
SHOPIFY_CLIENT_SECRET = <Secret>
```

The function exchanges these for a 24-hour access token via the client
credentials grant (`POST https://{shop}/admin/oauth/access_token`), caches it in
the warm container, and refreshes it automatically — including a single retry if
a cached token is invalidated early by a secret rotation or reinstall. The Secret
is only shown in full once; if you're unsure it was copied correctly, rotate it
and re-copy.

**B. Custom app created inside the store admin** (Settings → Apps and sales
channels → Develop apps). This yields a permanent token:

```
SHOPIFY_ADMIN_TOKEN = shpat_xxxxxxxxxxxxxxxxxxxxx
```

`SHOPIFY_ADMIN_TOKEN` takes precedence if both are set.

**Both styles require, in addition:**

- The app must have a **released version**, then be **installed on the store**.
  This is the step that is easy to miss — creating the app hands you credentials
  but does not install anything, and the credentials are rejected until it is.
  In the Dev Dashboard:
    1. **Versions** tab → fill in the app URL (the default is fine for an
       API-only app), pick a Webhooks API version, enter the scopes below →
       **Release**. An app cannot be installed without at least one version.
    2. **Home** → scroll to the bottom → **Install app** → select
       `pure-exploration` → **Install**.
  Changing scopes later needs a new released version, and the new scopes must
  then be approved in the store admin — they are not applied automatically.
- The app must be configured with these Admin API scopes. Scopes come from the
  app's configuration, not the token request, so changing them means releasing a
  new app version.

| Scope | Why |
|---|---|
| `write_orders` | create the order |
| `read_orders` | find existing orders for the "Ordered" badge — **optional**, see below |
| `read_products` | read the shirt's variants and live stock |
| `write_customers` | attach the student as the order's customer |

Only `read_products` and `write_orders` are strictly required. Without
`read_orders` the feature still works — you just lose the "Ordered" badge and
duplicate detection, and the popup says so. Without `read_products` nothing can
be ordered, and that failure is loud.

Note that `read_orders` only exposes the **last 60 days** of orders. A shirt
ordered longer ago than that stops showing an "Ordered" badge, so a student could
be double-ordered a season later. Widening that needs the `read_all_orders`
scope, which requires a permission request to Shopify.

Optional variables, only needed if something changes:

| Variable | Default | When to set it |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | `pure-exploration.myshopify.com` | You move stores. Must be the myshopify domain, not `pureexploration.com` |
| `SHOPIFY_API_VERSION` | `2026-04` | Shopify deprecates that version |
| `SHOPIFY_TSHIRT_PRODUCT_ID` | `gid://shopify/Product/9345666973947` | You replace the Pacific Discovery T-Shirt product |
| `SHIRT_ORDER_ROLES` | `admin,operations,programs,admissions` | You want to narrow who can order |

`HUBSPOT_TOKEN`, `JOTFORM_API_KEY` and `URL` are already set on this site and
are reused as-is. Re-deploy after changing any variable.

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

The application's **country** subfield is optional and often left blank (US
students especially). Since Shopify requires a country, it is resolved by
falling back: what the application said → the country on an associated HubSpot
contact → inference from a full state name ("Colorado" appears in exactly one
province table, so it means US). State **codes** resolve too, since US students
routinely write `PA` rather than `Pennsylvania` — but only codes that appear in
exactly one table. The genuinely ambiguous ones are left blank for a human:
`WA` (US Washington / AU Western Australia), `NT` (AU Northern Territory / CA
Northwest Territories) and `TAS` (AU Tasmania / NZ Tasman). The popup labels an
inferred country as such, so a value the student never typed stays visible.

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

## Adding a scope after the app is installed

Three things have to happen, and the third is easy to miss:

1. Add the scope to a new app version in the Dev Dashboard and **Release** it.
2. **Approve the new scopes on the store.** Shopify does not apply them to an
   already-installed app automatically.
3. Nothing — the dashboard handles the rest. Scopes are baked into the access
   token when it is minted, and a token lives 24 hours, so a token cached from
   before the change still lacks the new scope. Shopify reports that as an
   access-denied error inside an HTTP 200, not a 401, so the ordinary
   refresh-on-401 path would miss it. The function treats access-denied as a
   possible stale token, re-mints once, and retries — so a newly granted scope
   works immediately instead of after a redeploy or a day's wait.

## If a scope is missing

Shopify reports this as `Access denied for <field> field`, which names the field
but not the scope. The dashboard translates it: the message tells you which
scope to add, that it goes in Dev Dashboard → Versions → Release, and that new
scopes must then be approved in the store admin — they are **not** applied to an
already-installed app automatically.

## If the Shopify credentials are wrong

The error in the popup names the specific cause rather than relaying a status
code: rejected client credentials, an app that isn't installed, a missing scope,
a store domain that isn't the myshopify one, or a `SHOPIFY_ADMIN_TOKEN` set on a
site whose app only has Client ID/Secret.

## If Shopify is down

The Shirt Size column still works — it's HubSpot + Jotform only. The T-Shirt
column falls back to plain "Order T-Shirt" buttons, and clicking one explains
that Shopify isn't reachable instead of failing on submit.

---

## A note on Tailwind

This page pins **Tailwind 2.2.19** from a CDN, and that build is narrower than
current Tailwind in two ways that have already bitten this feature:

- **No `teal` or `amber`** in the palette. Those classes emit nothing, so a
  button styled with them renders white-on-white. The T-shirt UI uses
  indigo/yellow/green, which do exist.
- **No `disabled:` variants at all.** `disabled:opacity-50` is dead CSS, so a
  disabled button looks identical to a live one. There is an explicit
  `button:disabled` rule in the page's `<style>` block for this reason — don't
  remove it in favour of a `disabled:` utility.

`npm run test:shirt-ui` serves a real copy of the pinned stylesheet (from
`/tmp/tailwind.min.css`, or `TAILWIND_CSS`) rather than stubbing it out, and
asserts computed styles, so a dead class fails the test instead of shipping.

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
| `test/enrollment-shirt.test.mjs` | **New.** 24 assertions on the server-side resolution rules, with both upstreams stubbed. |
| `test/shirt-order.smoke.mjs` | **New.** 38 assertions driving the real page in headless Chromium. |
| `test/shirt-orders-auth.test.mjs` | **New.** 31 assertions on Shopify credential handling and the order guardrails, all upstreams stubbed. |

## Tests

```bash
npm run test:shirt       # size/address resolution rules (no network)
npm run test:shirt-auth  # Shopify credentials + order guardrails (no network)
npm run test:shirt-ui    # full page in headless Chromium (needs playwright)
```

All 93 assertions pass. `test:shirt-ui` skips cleanly with a message if Playwright isn't
installed.
