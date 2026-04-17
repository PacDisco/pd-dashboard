# Pacific Discovery Dashboards — Landing Page

A card-grid landing page at `dashboard.pacificdiscovery.org` that auto-updates
when new dashboards are added.

## How it works

1. Each dashboard lives in its own top-level folder with an `index.html`
   (you already have this — `enrollment/`, `lead-data-sheet/`, `report/`,
   `slider/`).
2. On every Netlify deploy, `scripts/build-manifest.js` scans the repo for
   folders that contain an `index.html` and regenerates `dashboards.json`.
3. `index.html` (the root landing page) fetches `dashboards.json` on load and
   renders a card for each dashboard.

**Net result:** push a new folder with an `index.html` → redeploy → a new card
shows up automatically. No code changes needed.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The landing page. Drop at repo root. |
| `dashboards.json` | Generated manifest. Safe to hand-edit; the build script preserves your edits. |
| `scripts/build-manifest.js` | Scans folders, writes `dashboards.json`. |
| `netlify.toml.snippet` | Add these lines to your `netlify.toml`. |

## Install (one-time)

1. Copy `index.html`, `dashboards.json`, and `scripts/` into the root of your
   Netlify repo (the one with `enrollment/`, `lead-data-sheet/`, etc.).
2. Merge `netlify.toml.snippet` into your existing `netlify.toml`. The key line is:

   ```toml
   [build]
     command = "node scripts/build-manifest.js"
   ```
3. Commit and push. Netlify rebuilds, regenerates `dashboards.json`, and the
   landing page goes live at `dashboard.pacificdiscovery.org`.

## Customizing a dashboard card

Two ways:

**Option A — edit `dashboards.json` directly.** Set `title`, `description`,
`category`, `icon`, `owner`, `pinned`, `colors`. Your edits are preserved
across rebuilds.

**Option B — drop a `dashboard.json` inside the dashboard folder.** For example,
`enrollment/dashboard.json`:

```json
{
  "title": "Student Enrollment",
  "description": "Pipeline, funnel, and conversion metrics.",
  "category": "Enrollment",
  "icon": "🎓",
  "owner": "Jake",
  "pinned": true,
  "colors": ["#7c9bff", "#6ee7b7"]
}
```

If neither is provided, the script falls back to the `<title>` and
`<meta name="description">` of the folder's `index.html`.

## Excluded folders

The script ignores `netlify`, `scripts`, `node_modules`, `.git`, `.netlify`,
`.github`, `assets`, `public`, `dist`, `build`, and any folder starting with
`.`. Add more in `scripts/build-manifest.js` if needed.

## Run locally

```bash
node scripts/build-manifest.js     # regenerates dashboards.json
python3 -m http.server 8080        # or any static server, then open :8080
```

# Forward Business Report — Netlify Dashboard

## Quick Deploy

1. Push this folder to a Git repo (GitHub, GitLab, Bitbucket)
2. Connect the repo to Netlify (netlify.com → Add new site → Import existing project)
3. In Netlify dashboard → Site settings → Environment variables, add:
   - `HUBSPOT_TOKEN` = your HubSpot Private App token

## HubSpot Private App Setup

1. Go to HubSpot → Settings → Integrations → Private Apps
2. Create a new app with these scopes:
   - `crm.objects.deals.read`
   - `crm.schemas.deals.read`
3. Copy the access token → add it as `HUBSPOT_TOKEN` in Netlify

## Configuration

Edit `netlify/functions/hubspot.js` to update:
- `PIPELINE_SEASON_MAP` — map your pipeline IDs to seasons
- `PROGRAM_CONFIG` — program display names, prices, max pax, targets
- `PAID_STAGES` — deal stages that count as "paid" enrollment

## Data Sources

The dashboard supports three data sources (toggle in the header):
- **Embedded** — hardcoded data from your original spreadsheet (works offline)
- **HubSpot** — live data from your HubSpot deals via the serverless function
- **Google Sheet** — published CSV from Google Sheets

When deployed on Netlify, it auto-detects and tries HubSpot first.

## Files

```
index.html                      — Dashboard report (single-file, self-contained)
netlify.toml                    — Netlify build config
netlify/functions/hubspot.js    — Serverless function that queries HubSpot API
```
