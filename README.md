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
