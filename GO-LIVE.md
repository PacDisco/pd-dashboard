# Cash Forecast — go-live runbook

Work through in order. Each step gates the next, so don't skip ahead — the Xero
consent in step 4 is the only awkward one to redo, and steps 1–3 exist to make
sure you don't have to.

Set this once in your shell:

```bash
S=https://your-dashboard-domain          # no trailing slash
KEY=your-xero-setup-key
```

Do **not** commit this file with real values in it.

---

## 1. Confirm the deploy is healthy

Four unauthenticated checks. None of them touch Xero.

```bash
curl -si $S/api/cash-forecast | head -1
curl -s  $S/api/cash-forecast
curl -si $S/.netlify/functions/cash-xero-auth | head -1
curl -s  $S/dashboards.json | grep -o cash-forecast
```

Expected:

| Check | Expect |
|---|---|
| status line | `HTTP/2 401` |
| body | `{"error":"Sign in required."}` |
| `cash-xero-auth` with no key | `HTTP/2 404` |
| `dashboards.json` | prints `cash-forecast` |

The third is a two-for-one: the function compares your `?key=` against the env
var, so a clean **404 proves the function loaded AND `XERO_SETUP_KEY` is set**.
A 500 there means the variable is missing.

**Stop and fix if:**

- **500 on `/api/cash-forecast`** — the module failed to load. Most likely the
  `../../cash-forecast/engine.mjs` import not resolving through Netlify's
  bundler. Check the function log; this is the failure I'd consider most likely
  since it was never deployed before.
- **404 on `/api/cash-forecast`** — the function didn't deploy, or `/api/*`
  didn't map. Confirm `cash-forecast.mjs` appears in Netlify → Functions.
- **`dashboards.json` prints nothing** — `build-manifest.js` didn't see the
  folder. Confirm `cash-forecast/index.html` exists in the deploy and that the
  build command ran.

---

## 2. Run the FX sync — still no Xero

Netlify → Functions → `cash-fx-sync` → **Invoke**.

```json
{"ok":true,"pair":"USDNZD","current":1.70…,"avg90":1.71…,
 "observations":60,"degraded":false}
```

This is the best single test in the whole sequence: it exercises function
invocation, outbound network, and a Netlify Blobs write, with nothing from Xero
involved. If Blobs is misconfigured you find out here, cheaply.

- `degraded: true` → Frankfurter was unreachable and it fell back to spot. The
  averages will all be the same number. Not fatal; re-invoke later.
- An error mentioning the store → Blobs problem, not an FX problem.

---

## 3. Open the dashboard, forecast-only

Sign in to the site as an `admin` or `operations` user and go to
`/cash-forecast/`.

You should see the page render with a warning reading *"No Xero actuals yet —
showing forecast only."* That warning is the pass condition, not a problem.

Also confirm now, before anyone else sees it:

- The **Payment rules** tab shows the planning-rate options with real numbers
  from step 2 next to them.
- Sign in as an `admissions` user (or ask someone who is) and confirm
  `/cash-forecast/` is refused. If it loads, `dashboard.json`'s `allowedRoles`
  didn't take — check `dashboards.discovery.json` in the deploy.

---

## 4. Xero consent — the one-shot step

Open in a browser, signed in to Xero as a user who can see Pacific Discovery:

```
$S/.netlify/functions/cash-xero-auth?key=$KEY
```

On the Xero consent screen, **tick Pacific Discovery only**.

The callback returns plain text listing the organisation and its tenant ID.
**Copy that tenant ID and set it as `XERO_TENANTS`.** Without it the sync pulls
every organisation ever authorised on the Xero app, so a future consent — or
someone else's — would silently widen what the dashboard shows.

- **"State mismatch"** → start again from the auth URL rather than re-loading
  the callback. The state is single-use by design.
- **`redirect_uri` / `unauthorized_client` error from Xero** → `XERO_REDIRECT_URI`
  doesn't match what's registered on the Xero app, character for character.
  Trailing slashes count.
- **Want to add an entity later** → run the auth URL again, tick it, and add its
  tenant ID to `XERO_TENANTS`. Xero adds newly consented tenants to the existing
  connection, so the pin is what actually controls scope.

---

## 5. Run the Xero sync

Netlify → Functions → `cash-xero-sync` → **Invoke**.

```json
{"ok":true,"orgs":4,"errors":[]}
```

A non-empty `errors` array names the org and the message; one bad org doesn't
stop the others, by design.

---

## 6. Verify the actuals — do not skip this

The report parsers were written against Xero's **documented** row shapes, not
against your books. Nesting varies by organisation and chart-of-accounts depth.
Check in this order, because each wrong answer invalidates the ones below it.

```bash
curl -s $S/api/cash-position -H "cookie: nf_jwt=<your session cookie>" | jq
```

Or just read the Xero actuals panel at the bottom of the Cash flow tab.

1. **Bank balance per account** matches Xero's own Bank Summary report for the
   current month. This is the number everything else rests on.
2. **Receivables and payables** match the Balance Sheet.
3. **Only Pacific Discovery appears** in the actuals panel. A second entity
   means `XERO_TENANTS` isn't pinned.
4. **`byProgram`** lists your real program names. Empty or wrong grouping →
   set `XERO_PROGRAM_CATEGORY` to the exact name of your tracking category.
5. **`tokenHealth.daysRemaining`** reads about 60.

If 1 or 2 are wrong, that's a parser problem and the fixtures in
`test/cash-xero-parsers.test.mjs` need updating against your real shape.

---

## 7. Prove the refresh path

Wait an hour (or trigger `cash-xero-sync` again after 30+ minutes) and confirm
it still returns `ok:true`.

Access tokens expire after 30 minutes, so a second successful run is what proves
the refresh-and-rotate path works. Until you've seen that, the integration is
unverified in the way that matters most — a broken refresh looks fine for half an
hour and then stops forever.

---

## 8. Set the real inputs

Everything shown so far is placeholder. On the dashboard, as an editor:

- **Programs & pax** — real departure and return dates, real per-program pax.
  The seeded split spread each season's total evenly across its programs, which
  is almost certainly wrong.
- **Payment rules** — your actual deposit and balance-due days.
- **Overheads** — opening NZD and USD balances at 1 April, and the buffer.

Then hit **Save**. Every save is versioned, so you can compare and roll back.

Still genuinely missing, and worth deciding on: **GST and PAYE**. Neither
existed in the workbook. For an NZ entity they're among the largest and lumpiest
movements in the year, and their absence is a bigger hole than anything the
integration fixed.

---

## 9. Close the setup door

Once consent has succeeded, delete `XERO_SETUP_KEY` from Netlify. The key check
reads the variable directly, so with it absent the function throws and the
endpoint fails closed. Add a fresh key back if you ever need to re-consent.

---

## 10. Confirm the schedules

Netlify → Functions should show:

| Function | Schedule |
|---|---|
| `cash-xero-sync` | `@hourly` |
| `cash-fx-sync` | `0 20 * * *` (20:00 UTC = 8am NZ, after the ECB publishes) |

If they're listed as regular rather than scheduled functions, the `export const
config` block didn't register — check the deploy log.

---

## Ongoing

The one thing that will eventually break: **the refresh token expires 60 days
after its last rotation.** While the hourly sync is running it rotates
constantly and never comes close. But if the site is paused, the function is
disabled, or the sync fails for two months, you'll need to re-run step 4.

`tokenHealth.daysRemaining` is on the dashboard for exactly this. If it ever
reads under 14 the page says so in the warnings strip.
