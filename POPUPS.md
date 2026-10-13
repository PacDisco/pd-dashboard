# Website Popups

Design popups for pacificdiscovery.org in the dashboard (**/popups/**), choose
which pages they appear on and when, and send every sign-up straight into
HubSpot as a new Pacific Discovery lead.

## How it fits together

| Piece | What it does |
|---|---|
| `popups/` | The designer: list, live preview (desktop / phone), content, form fields, pages, timing, style. |
| `netlify/functions/popups.mjs` | Designer API (signed-in users with access to the Website Popups dashboard). Saves to Netlify Blobs, uploads images, lists HubSpot properties. |
| `netlify/functions/popup-embed.mjs` | **Public.** The script the website loads (via GTM), plus uploaded popup images. Only switched-on popups, cached 60 s. |
| `netlify/functions/popup-submit.mjs` | **Public.** Receives a sign-up, writes it to HubSpot and emails the team. Only accepts requests from the website's own origins. |
| `netlify/functions/popups-gmail.mjs` | Connects the Google Workspace mailbox that sends team notifications (designer only). |
| `netlify/functions/_shared/popups-gmail.mjs` | Builds and sends the notification email (Gmail API, send-only permission). |
| `netlify/functions/_shared/popups-core.mjs` | Data model, validation, page matching, HubSpot mapping (pure, tested). |
| `netlify/functions/_shared/popup-runtime.mjs` | The popup itself. The same code runs on the website and in the designer preview. Drawn in a Shadow DOM so the site's CSS can't restyle it. |

Storage: Netlify Blobs store `popups` (`doc` = all popups, `stats` = sign-up counts, `img/*` = images, `gmail` = the connected mailbox's refresh token). No database migration needed.

## One-time setup

1. **Deploy** this zip to the dashboard site. The build adds "Website Popups" to the dashboard list automatically (Outreach; roles admin, outreach, admissions — change in `popups/dashboard.json` or the dashboard's permissions).
2. **HubSpot token.** The dashboard's existing `HUBSPOT_TOKEN` is used. It needs these private-app scopes:
   - `crm.objects.contacts.read` and `crm.objects.contacts.write` — find and create/update contacts (and add the timeline note)
   - `crm.schemas.contacts.read` — lets the designer list properties and load dropdown choices (optional: without it you type property names instead)
   To keep popups on a separate key, create a private app with just those scopes and set `POPUP_HUBSPOT_TOKEN` instead.
3. **GTM.** Add a *Custom HTML* tag, trigger *All Pages*:
   ```html
   <script src="https://dashboard.pacificdiscovery.org/api/popup-embed" async></script>
   ```
   (The designer's list page shows the exact snippet.) Each popup decides its own pages, so the tag can run everywhere.
4. Optional: `POPUP_ALLOWED_ORIGINS` (comma-separated) if sign-ups should also be accepted from another domain. Default: `https://www.pacificdiscovery.org,https://pacificdiscovery.org`.

## Team email notifications

Each popup has an **Email the team** list (Form tab, up to 10 addresses). When someone signs up, each address gets an email with their name, answers, the page, whether they're new or existing in HubSpot, and an **Open in HubSpot** button. **Reply-To is the visitor**, so hitting reply answers them directly.

Emails are sent from a Google Workspace mailbox you connect once in the designer (**Connect Gmail**). It gets the `gmail.send` permission only — it can send, not read. One-time Google setup:

1. Google Cloud console → the project with the dashboard's OAuth client (`GOOGLE_OAUTH_CLIENT_ID`) → **APIs & Services → Library** → enable **Gmail API**.
2. **Credentials** → that OAuth client → add the authorised redirect URI shown in the designer:
   `https://dashboard.pacificdiscovery.org/api/popups-gmail?action=callback`
3. **OAuth consent screen**: if it's set to *Internal* (your Workspace only), no Google review is needed. Add the `.../auth/gmail.send` scope if the screen lists scopes.
4. In the designer, click **Connect Gmail**, sign in as the sending address (e.g. info@pacificdiscovery.org), then **Send a test email**.

If sending ever fails (e.g. the mailbox's password changed and Google revoked access), the designer shows the last error; reconnect to fix it. If HubSpot is down when someone signs up but the email goes out, the visitor still sees "thanks" and the lead is in your inbox.

## What happens in HubSpot

On every sign-up:

- The contact is found by email, or created.
- `company_tag` = **Pacific Discovery**. If `company_tag` is a multi-select, other brands already on the contact are kept.
- **Lead status = New** — on every submission, including existing contacts.
- **Lifecycle stage = Lead** for new contacts and subscribers. Contacts already further along (MQL, opportunity, customer…) keep their stage: HubSpot doesn't allow moving a contact backwards.
- Each form field goes to the HubSpot property chosen in the designer (defaults: first name, last name, email, phone, `program_interest`, `program_dates`; "I am a…" isn't saved until you pick a property for it).
- A **note** on the contact's timeline records the popup, the page and every answer.
- The visitor is identified to HubSpot's tracking code, so their page views attach to the contact.

Safety nets: a dropdown value HubSpot wouldn't accept, or a property that doesn't exist, is left out (and logged) rather than losing the lead; if HubSpot still refuses, it retries with just the essentials.

## Targeting and timing

- **Pages:** every page, only listed pages, or every page except listed ones. Use page addresses, full URLs, or `*` (e.g. `/programs/*`). The designer has quick-add buttons for the homepage, all program pages, and each program page.
- **Devices:** desktop and phones, desktop only, phones only.
- **When:** after N seconds, after scrolling N% of the page, and/or when the visitor moves to leave (desktop) — whichever happens first.
- **How often:** closed popups stay hidden for N days; anyone who signs up never sees that popup again.
- **Schedule:** optional start and end dates.
- **Priority:** only one popup shows per page view — the first eligible one in the list order (↑ in the list moves one up).

## Analytics

The popup pushes these to the GTM data layer, with `popupId` and `popupName` (and `program` on submit), ready for GA4 conversion tags:
`pd_popup_view`, `pd_popup_submit`, `pd_popup_close`.

## Tests

```
node --test test/popups.test.mjs                               # data model, targeting, HubSpot mapping (mocked)
PW_CHROMIUM=/path/to/chrome node test/popups.smoke.mjs         # designer + the popup on a fake site page
```
