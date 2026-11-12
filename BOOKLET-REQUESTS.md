# Info booklet requests

The booklet buttons on program and landing pages (pd-program-pages): **Get the
itinerary**, **Download full itinerary**, the closing call to action, and the
landing pages' booklet buttons. They ask for a few details, then open the
booklet and email the visitor the link.

```
 www.pacificdiscovery.org/programs/<slug>             pd-dashboard
 ┌─────────────────────────────────┐  POST   ┌───────────────────────────────────────────┐
 │ "Get the itinerary"  → form      │───────▶│ /api/booklet-request                       │
 │ name, email, phone, student/par. │        │  1. booklet link from the PUBLISHED page   │
 │                                  │◀───────│  2. HubSpot (same as popups)               │
 │ opens the booklet link           │  {url} │  3. emails the visitor the link (Gmail)    │
 └─────────────────────────────────┘        │  4. optional team email                    │
                                             └───────────────────────────────────────────┘
```

## Setting a page's booklet

Program Pages → the page → **Page settings → Info booklet download link**. Paste
the booklet itself (a PDF link, a Google Drive file shared "anyone with the link",
etc.) and publish.

- The live page never contains this link. The dashboard looks it up from the
  published page when someone submits, so the form (or the email) is the only way
  to it, and nobody can use the endpoint to email a link of their choosing.
- Pages still set to the old `…/admissions/request-program-booklet` page keep a
  plain link to it, exactly as before. Pages switch over one by one as you paste
  real booklet links.
- The editor preview shows plain links; the form only appears on the live page.
- Someone who has already filled in the form on that device goes straight to the
  booklet next time.
- Link to `…/programs/<slug>#get-booklet` (e.g. from an ad or email) to open the
  form as the page loads.

## What happens on submit

| | |
|---|---|
| HubSpot | Same as a popup sign-up (`_shared/popups-hubspot.mjs`): phone (required) goes to `phone`; contact found by email or created, `company_tag` = Pacific Discovery, Lead status = New, Lifecycle = Lead unless further along, a timeline note “Website popup: Info booklet: <program>” with a PDF of the answers. On program pages, `program_interest` is set to the dropdown option whose label (or value) matches the page name or slug; if none matches, it's left out and only the note has it. |
| Visitor email | “Your <program> booklet”, from the Gmail mailbox connected in **Website Popups → Connect Gmail**, sender name *Pacific Discovery*. Replies go to that mailbox (or `BOOKLET_REPLY_TO`). |
| Team email | Only if `BOOKLET_NOTIFY_EMAILS` is set. Same format as popup notifications, Reply-To = the visitor. |
| GTM data layer | `pd_booklet_open`, `pd_booklet_submit`, `pd_booklet_repeat` (with `program` = slug), ready for GA4/Meta/TikTok conversion tags. |

The visitor always gets the booklet once their details are valid. If HubSpot or
Gmail fails, it's logged (`[booklet-request]` in the function log, and a Gmail
failure shows in the popup designer like popup notification failures). If both
fail, the log line says `LEAD NOT SAVED` with the email address.

## Environment variables (all optional)

| Name | Default | |
|---|---|---|
| `BOOKLET_ALLOWED_ORIGINS` | `https://www.pacificdiscovery.org,https://pacificdiscovery.org,https://pd-program-pages.netlify.app` | Sites the form may post from. |
| `BOOKLET_NOTIFY_EMAILS` | none | Comma-separated team addresses to email on each request. |
| `BOOKLET_REPLY_TO` | the sending mailbox | Reply-To on the visitor's email. |
| `BOOKLET_ROLE_PROPERTY` | none | HubSpot property for Student / Parent (values `Student`, `Parent`). Without it, the role is in the note only. |
| `BOOKLET_PROGRAM_PROPERTY` | `program_interest` | Property for the program. `none` to skip. |

Uses the existing `HUBSPOT_TOKEN` (or `POPUP_HUBSPOT_TOKEN`), `NETLIFY_DATABASE_URL`,
`GOOGLE_OAUTH_CLIENT_ID/SECRET` and the Gmail mailbox already connected for popups.
No migration.

## Files

| Path | |
|---|---|
| `netlify/functions/booklet-request.mjs` | **Public** endpoint. Origin-checked, throttled (6/min per IP), honeypot + timing check. |
| `netlify/functions/_shared/booklet-core.mjs` | Validation, booklet-link rule, HubSpot mapping, the visitor email (pure, tested). |
| `test/booklet.test.mjs` | `npm run test:booklet` |
| `program-pages/template/render.mjs` | Pinned template copy, synced from pd-program-pages (the form itself lives there). |

## Rollout

1. Deploy **pd-dashboard** first (the endpoint has to exist before any page points at it).
2. Deploy **pd-program-pages** (the template and build change).
3. Check that a Gmail mailbox is connected in Website Popups. Without it, leads
   still reach HubSpot and visitors still get the booklet, but nobody is emailed.
4. For each program: paste the booklet link, publish, and test with your own email.
