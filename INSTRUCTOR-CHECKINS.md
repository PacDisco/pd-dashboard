# Instructor check-ins

Instructors book weekly check-ins from their portal. Staff manage everything from the **Instructor Check-ins** dashboard (`/instructor-checkins/`, roles `admin, programs, operations`).

```
instructor portal (browser)
   └─ /api/checkins/slots|book            portal function: netlify/functions/checkins.mjs
        └─ X-PD-Service-Key ─────────────▶ dashboard: /api/checkins/slots|book
                                             └─ Google Calendar (free/busy + create event)
dashboard page /instructor-checkins/ ────▶ /api/checkins/admin, /api/checkins/oauth/*  (Netlify Identity)
```

## What it does

- **Slots** are offered only when every connected staff member who blocks times is free. Each person's calendar is read with their **own** Google sign-in, so this works across Workspace domains with no calendar sharing.
- **Bookings** are created on the host's chosen calendar, with a Meet link. The instructor and everyone on the list are invited (`sendUpdates=all`). Weekly series keep the same NZ wall-clock time across daylight saving changes.
- **Guests can be changed on a booked check-in** from Google Calendar by anyone on the invite (`guestsCanModify`), on any domain.
- **The dashboard** shows the next 4 weeks of bookings. From it you manage who's invited, connect calendars, pick the host, choose the calendar, and set hours, length, buffer, notice, horizon and max series length. All of this is stored in Blobs (`instructor-checkins/settings`), so no redeploys are needed.

## Files

| File | |
|---|---|
| `instructor-checkins/index.html`, `dashboard.json` | Dashboard page |
| `netlify/functions/_shared/checkins.mjs` | Google calls, slot/tz maths, Blobs settings, portal key, OAuth state |
| `netlify/functions/_shared/checkins-access.mjs` | `requireManager`, the same rule as the page (via `dashboard-access.js`) |
| `netlify/functions/checkins-admin.mjs` | `GET/POST /api/checkins/admin` |
| `netlify/functions/checkins-oauth.mjs` | `/api/checkins/oauth/start` + `/callback` |
| `netlify/functions/checkins-slots.mjs` | `GET /api/checkins/slots` (portal key) |
| `netlify/functions/checkins-book.mjs` | `POST /api/checkins/book` (portal key) |
| `test/instructor-checkins.test.mjs` | `npm run test:checkins` |

## Setup

### 1. Google Cloud (new project, e.g. "PD Instructor Check-ins")
1. Enable the **Google Calendar API**.
2. **Google Auth Platform**:
   - **Branding:** app name, support email, home page, privacy policy, and authorised domain `pacificdiscovery.org`. Don't upload a logo, because that triggers brand verification.
   - **Audience:** External, then **Publish app → In production**. In Testing mode, connections expire after 7 days.
   - **Data Access:** add `calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly`, `openid`, and `userinfo.email`.
   - **Clients:** create a **Web application** client with this redirect URI:
     `https://dashboard.pacificdiscovery.org/api/checkins/oauth/callback`

### 2. Dashboard site env vars
| Variable | |
|---|---|
| `CHECKINS_GOOGLE_CLIENT_ID` | from step 1 |
| `CHECKINS_GOOGLE_CLIENT_SECRET` | from step 1 |
| `INSTRUCTOR_PORTAL_KEY` | **already set** (checklist). Reused here |

### 3. Portal site
- Add `netlify/functions/checkins.mjs`.
- Set env `CHECKINS_API_URL=https://dashboard.pacificdiscovery.org/api/checkins`. `INSTRUCTOR_PORTAL_KEY` is already set.
- Paste `checkin-widget.html` into the portal page where instructors should book. If the portal knows the logged-in instructor, fill `data-name` and `data-email`.

### 4. Deploy both, then in the dashboard
1. Open **Instructor Check-ins**, add yourself and click **Connect calendar**. On Google's "unverified app" screen, click Advanced → Continue, then tick both calendar boxes. The first connection becomes the **host**.
2. Pick **Save check-ins to**. A dedicated calendar shared with the team works well.
3. Add the other staff. Have each one **Connect calendar** as themselves if their busy times should block slots.
4. Set the weekly hours and save.

## Troubleshooting
- **redirect_uri_mismatch:** the URI in Google must match exactly (https, no trailing slash).
- **"Access blocked by your admin":** that domain's Workspace restricts third-party apps. In the Admin console, go to Security → API controls → Manage third-party app access, and trust the Client ID. Do this once per domain.
- **Calendar dropdown shows a "Reconnect" warning:** the host connected before the calendar-list scope existed. Click Reconnect.
- **Portal form says "not set up yet":** no host calendar has been connected.
- **Portal form says "isn't configured":** the portal is missing `CHECKINS_API_URL` or `INSTRUCTOR_PORTAL_KEY`.
