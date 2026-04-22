# Invoices & Payments tool

Drop-in dashboard for the existing Pacific Discovery Netlify repo. Adds a new "Invoices & Payments" card to the landing page that lets your team:

- **Upload** invoices (PDF / image) — AI parses the vendor, amount, invoice # and due date.
- **Email in** invoices — a Gmail label + Apps Script trigger forwards them automatically.
- **Manually schedule** a payment (recurring transfers, reimbursements, etc. — no file).
- **See a weekly schedule** of upcoming payments with *Approved to pay* / *Reschedule* / *Paid* actions on each row.

Files in the repo use the same folder-per-tool pattern as your other dashboards (Stripe, Enrollment, etc.) — `build-manifest.js` will pick it up automatically.

---

## Files to place in your repo

| From this package                              | Goes in your repo as                           |
| ---------------------------------------------- | ---------------------------------------------- |
| `invoices/index.html`                          | `invoices/index.html`                          |
| `invoices/dashboard.json`                      | `invoices/dashboard.json`                      |
| `invoices/README.md` *(optional, for your docs)* | `invoices/README.md`                         |
| `netlify/functions/invoices.js`                | `netlify/functions/invoices.js`                |
| `db/schema.sql`                                | `db/schema.sql` (or run once & discard)        |
| `apps-script/Code.gs`                          | Paste into a new Apps Script project           |

No edits to `index.html`, `netlify.toml`, or `scripts/build-manifest.js` needed.

---

## One-time setup

### 1. Netlify DB (Postgres)

From the repo root:

```bash
netlify db init          # provisions a Neon Postgres DB and injects NETLIFY_DATABASE_URL
netlify db exec < db/schema.sql
```

This creates the `payments` and `programs` tables. Seeded with five placeholder programs — edit the `INSERT INTO programs` rows in `db/schema.sql` to match your actual programs, or edit via SQL later.

### 2. Install function dependencies

The function needs three npm packages. From your repo root:

```bash
npm install @neondatabase/serverless googleapis @anthropic-ai/sdk
```

(If your existing functions already have a `package.json`, add these to it; Netlify installs them on deploy.)

### 3. Google Cloud — service account for Drive

1. Go to https://console.cloud.google.com → pick or create a project.
2. **APIs & Services → Enable APIs** → enable **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create Service Account**. Name it `invoices-uploader`, no role needed.
4. On the new service account → **Keys → Add Key → JSON**. Download the JSON file.
5. In Google Drive, create a folder (e.g. `Invoices`). Right-click → **Share** → paste the service account's email (looks like `invoices-uploader@your-project.iam.gserviceaccount.com`) → give **Editor** access.
6. Copy the folder ID from its URL: `drive.google.com/drive/folders/FOLDER_ID_HERE`.

### 4. Anthropic API key

Go to https://console.anthropic.com → **API Keys → Create Key**. Copy it.

### 5. Netlify environment variables

In your Netlify site → **Site settings → Environment variables**, add:

| Key                           | Value                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`           | Your Anthropic key                                                       |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The entire contents of the JSON key file (paste as one line)             |
| `GOOGLE_DRIVE_FOLDER_ID`      | The Drive folder ID from step 3.6                                        |
| `INVOICES_INBOUND_SECRET`     | Any long random string (e.g. `openssl rand -hex 32`). Used by Apps Script. |

`NETLIFY_DATABASE_URL` is auto-injected by `netlify db init` — you don't set it manually.

Redeploy once env vars are set.

### 6. Gmail + Apps Script (email-in path)

1. In Gmail (ideally a shared `invoices@boulderdigitalmedia.com` account):
   - Create a label **`Invoices/To Process`** (Settings → Labels → Create).
   - Create a filter: Matches "has attachment AND (subject has `invoice` OR from:your-vendors…)" → Apply label `Invoices/To Process`.
2. Go to https://script.google.com → **New project** → replace the default code with `apps-script/Code.gs`.
3. At the top of `Code.gs`, fill in `CONFIG.NETLIFY_URL` (your dashboard's URL) and `CONFIG.SHARED_SECRET` (same value as `INVOICES_INBOUND_SECRET`).
4. Click **Run** on `forwardInvoices` — Google prompts for permissions (it needs Gmail read and external HTTP access). Approve.
5. Click the **Triggers** icon (clock) → **Add Trigger** → Function `forwardInvoices`, Event `Time-driven`, Type `Minutes timer`, `Every 10 minutes`. Save.

From then on, any email landing in `Invoices/To Process` will be forwarded to your dashboard within ~10 minutes, show up on the dashboard, and be moved to `Invoices/Processed`.

---

## Daily use

**Upload tab** — drop a PDF. Claude extracts vendor/amount/due date. The file is saved to your Drive folder, a row appears on the Dashboard.

**Manual Entry tab** — fill in a vendor, amount, due date, and optional program. No file needed.

**Dashboard tab** — payments grouped by the week they're due.
- The top KPIs summarize what's due within 7 days, what's awaiting approval, what's approved but unpaid, and total outstanding.
- Each row has three actions: **Approved** checkbox (flips `approved_to_pay`), **Reschedule** button (prompts for a new date + reason, preserves the original), **Paid** checkbox (stamps `paid_date` to today).
- Click the 📄 icon on any row to open the original invoice in Drive.
- Filter by status and program.

---

## Managing the programs list

To add / rename / deactivate programs, run SQL against Netlify DB:

```sql
-- Add a program
INSERT INTO programs (name, sort_order) VALUES ('Outdoor Ed', 60);

-- Rename
UPDATE programs SET name = 'Marketing & Comms' WHERE name = 'Marketing';

-- Hide from the dropdown without losing historical data
UPDATE programs SET is_active = FALSE WHERE name = 'Old Program Name';
```

(If you want a proper UI for this later, it's a small addition — another action on the Netlify Function plus a settings panel in `index.html`.)

---

## Architecture at a glance

```
Browser (invoices/index.html)
        │  fetch /api/invoices?action=...
        ▼
Netlify Function (netlify/functions/invoices.js)
        │            │                │
        ▼            ▼                ▼
   Netlify DB    Google Drive    Anthropic (Claude)
   (payments,   (invoice PDFs    (parses each
    programs)    via service     uploaded/emailed
                 account)         invoice)

              ▲
              │ POST (every 10 min)
              │
   Gmail + Apps Script  ──► /api/invoices?action=inbound
```

---

## Costs (rough)

- **Netlify DB**: free tier covers thousands of invoices.
- **Google Drive**: uses your existing Workspace storage.
- **Claude API**: ~$0.01–0.05 per invoice parsed.
- **Apps Script**: free.

Expect under $5/mo at typical small-org volume.

---

## Known limitations & next steps

- **Claude parsing** occasionally misreads ambiguous due dates. The Dashboard lets you click any row to edit (you'd add an inline edit handler if you want — the function's `update` action already supports editing any field).
- **No audit log** — changes aren't versioned. Easy to add: an `audit` table + an insert on each update.
- **Programs are DB-managed, not UI-managed.** See above.
- **No auth on the function itself** — relies on your existing dashboard's auth gate in front of the page. If the function URL is callable anonymously and that matters, add a check against `users.js` at the top of the handler.
