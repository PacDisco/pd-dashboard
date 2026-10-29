# Lead Alerts — admissions phone app

`/lead-alerts/` is an installable phone app (PWA) that pushes a notification the
moment a Pacific Discovery lead does something worth a same-hour follow-up, and
shows a red count of what's new since the advisor last opened it.

## What raises an alert

| Alert | Source | Checked |
|---|---|---|
| **Application started** | new row in Neon `applications` (pd-apply step 1) | every 2 min |
| **Application submitted** | `applications.step2_at` set | every 2 min |
| **Quiz completed** | new row in Neon `quiz_responses` | every 2 min |
| **New lead** | a contact with `company_tag = Pacific Discovery` whose `hs_lead_status` is set to NEW (booklet, popup, Zapier, manual…) | every 2 min |

- pd-apply resets lead status to NEW itself, so a **New lead** alert is dropped if
  the same email already has an application/quiz alert within ±3 hours — one
  ping per action, not two.
- Worst case from action to phone: ~2–3 minutes.
- Going live doesn't flood: the first scan records a baseline and only alerts
  what happens after it.

## The follow-up loop

- Each card shows a countdown to the 60-minute mark, then **Overdue** in red.
- Card buttons: **Copy number** · **Open Aircall** · **HubSpot** · **Contacted**.
  Calls and texts go through the Aircall app, which logs them to HubSpot.
  Open Aircall copies the number first, so she just pastes it in Aircall.
  It opens the app on iPhone (`aircall://`) and Android (by package name,
  `com.aircall`); on a computer the button is greyed out. HubSpot opens the
  contact record. No Aircall API key is needed.
- An alert also closes **automatically** when HubSpot shows a logged
  call/email/meeting after it (`notes_last_contacted`, e.g. Aircall) or the lead
  status moves off NEW.
- One **reminder** push goes out if an alert is still open after 45 minutes
  (`LEAD_ALERTS_REMIND_MIN`, `0` turns it off).
- Header stats: open, overdue, median response time and % inside the hour (7 days).

## Available hours (default 24/7)

Tap the **On / Off** bar under the header to set your hours: Always on, or a
start–end time per day (presets: weekdays 9–5, every day 8am–8pm, copy Monday
to all), in your phone's time zone. Each person on the app has their own hours.

- **Outside your hours** nothing is pushed to your phones. Alerts still land in
  the app, and you can open it any time.
- **When your hours start**, within ~2 minutes you get **one** "While you were
  off" notification listing every alert that came in while you were off and is
  still open (e.g. "While you were off: 4 leads waiting — 1 application,
  2 quizzes, 1 new lead"). Anything already marked contacted, or closed by
  HubSpot activity overnight, is left out.
- **The 60 minutes for those start when your hours do**, not at 2am: the card
  says "Came in off-hours · due 10:00 AM", overdue and the response stats use
  that time, and the 45-minute reminder comes 45 minutes into your day.
- Saving hours that switch you on right now sends the digest straight away.
- Blocks can cross midnight (e.g. 20:00 → 02:00). Use 11:59 PM for "until midnight".
- Reminders are per person, so two advisors with different hours each get their own.

## The red bubble

- **In the app**: alerts that arrived since the app was last opened (or brought
  back to the foreground).
- **On the app icon**: the same count, set by each push via the Badging API.
  iPhone (installed to Home Screen) shows the number; Android Chrome shows a dot
  or the notification count depending on the launcher.
- **On the dashboards landing page**: the Lead Alerts tile has the usual
  coral bubble (TILE-BADGES.md).

## Setup (once)

1. **VAPID keys** — run `npx web-push generate-vapid-keys` and add to Netlify
   env vars (Functions scope):
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` = `mailto:admissions@pacificdiscovery.org`
   Never change the keys afterwards — every phone would have to re-enable.
2. Optional: `LEAD_ALERTS_TZ` (default `America/Los_Angeles`) — the zone used for
   "follow up by 3:45 PM" in notification text. `LEAD_ALERTS_REMIND_MIN` (default 45).
3. Deploy. Tables create themselves (schema in `MIGRATION-lead-alerts.sql`).
   Uses existing `NETLIFY_DATABASE_URL` and `HUBSPOT_TOKEN`.
4. Give the advisor access to **Lead Alerts** in the admin access screen
   (default roles: admin, admissions).

## Installing on a phone

**iPhone (iOS 16.4+)** — open `dashboard.pacificdiscovery.org/lead-alerts/` in
**Safari** → Share → **Add to Home Screen** → open it from the Home Screen →
sign in → **Turn on notifications** → Allow. Push does not work in a Safari tab,
only from the Home Screen app. Check Settings → Notifications → Lead Alerts has
Badges on.

**Android** — open the same URL in **Chrome** → sign in → **Turn on
notifications** → Allow → menu → **Install app / Add to Home screen**.

Use **Send a test notification** at the bottom of the app to confirm.

## How it's built

- `lead-alerts/` — the app shell (`index.html`), `sw.js` (push, badge,
  offline shell), `manifest.webmanifest`, icons. Excluded from the edge auth gate
  (netlify.toml) and from `_redirects` Role= rules (build-manifest
  `PUBLIC_SHELL_SLUGS`) so the installed app always loads; it signs in with
  Netlify Identity and sends a Bearer token.
- `netlify/functions/lead-alerts.mjs` — `/api/lead-alerts[/seen|handled|subscribe|unsubscribe|prefs|test|scan]`;
  every call verifies the Identity token and Lead Alerts access.
- `netlify/functions/lead-alerts-scan.mjs` — scheduled `*/2 * * * *`.
- `netlify/functions/_shared/lead-alerts.mjs` — sources, de-dupe, push, hours/digest, storage.
- `netlify/functions/_shared/lead-alerts-hours.mjs` — the available-hours rules (pure).
- Pushes are re-checked against dashboard access at send time; a person who
  loses access has their phones removed. Dead subscriptions (404/410) are removed.

## Tests

- `npm run test:lead-alerts` — pure logic, including the hours rules (DST, overnight blocks)
- `npm run test:lead-alerts-ui` — the app at phone size in headless Chromium
- `npm run test:lead-alerts-db` — the full scan against a scratch PostgreSQL
  (needs `DATABASE_URL` and `npm i pg`; instructions in the file)
