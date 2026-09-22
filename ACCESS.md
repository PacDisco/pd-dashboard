# Dashboard access

Access to a dashboard is granted **per person**, by email. Roles no longer
decide what anybody can see.

## The rule

One implementation, in `netlify/edge-functions/lib/dashboard-access.js`,
imported by both the edge gate and the config function so the two can't drift:

1. `admin` role → every dashboard, always.
2. The person has a saved list → they get exactly what it names. An empty list
   means **no dashboards** — it is a real answer, not a fall-through.
3. The person has no list yet → fall back to the old role rule
   (`dashboard.allowedRoles` ∩ their roles).

Step 3 is what makes this safe to deploy on a normal Tuesday. Before anyone has
been given a list, everybody keeps precisely the access they have today. People
move onto the new rule one at a time, as you save their list.

## Where it's stored

Netlify Blobs, store `dashboards`, key `grants`:

```json
{
  "version": 1,
  "updatedAt": "2026-09-22T09:00:00.000Z",
  "updatedBy": "jake@boulderdigitalmedia.com",
  "users": {
    "megan@pacificdiscovery.org": ["enrollment", "pipeline", "sales-funnel"],
    "zach@pacificdiscovery.org": ["invoices", "stripe", "cash-forecast"]
  }
}
```

Emails and slugs are lowercased on the way in. Slugs that don't match a real
dashboard are dropped at save time rather than sitting in the document forever.
It's read live on every request, so changes take effect immediately — no
redeploy.

The old `permissions` key (per-dashboard `allowedRoles` overrides) is still
read, because it supplies the `allowedRoles` used by the step-3 fallback.

## Using it

**Manage access → Dashboard access.** Same table as before — dashboards down the
side — but the columns are people now, not roles. Tick the cells.

- Clicking a **person's name** gives them everything, or takes it all away.
- Clicking a **dashboard name** gives that dashboard to everyone currently shown
  (respecting the people filter), or takes it off them.
- An **amber-shaded column** is someone with no saved list yet: the ticks show
  what their roles give them today. Touching any cell in that column first
  writes down exactly what's on screen, then applies your change — so switching
  someone across can only ever do what you can see it doing.
- An **admin** column is ticked throughout and locked. Drop the admin role on the
  People & powers tab to assign them dashboards individually.

**Seed from roles** fills every column with exactly what that person's roles give
them today. It only stages the lists — nothing is written until you press *Save
access* — so you can review before committing. Running it once and saving is the
clean way to switch the whole team over without changing anyone's access.

Nothing is sent for people you never touched, so they keep falling back to roles
until you get to them.

## What roles still do

They gate what someone may **do** inside a dashboard, not what they can open:

| Where | Check |
|---|---|
| `marketing-spend.mjs` | `admin`, `outreach` or `operations` may write spend |
| `time-tracking.js` | manager roles approve a period |
| `enrollment-status.mjs` | `ENROLLMENT_DROP_ROLES` may mark a student dropped |
| `shirt-orders.mjs` | `SHIRT_ORDER_ROLES` may place an order |
| `_shared/cash-access.mjs` | who may open the cash forecast data |
| `budget-admin.mjs` | `WRITE_ROLES` may edit field budgets |
| `users.js`, `config.js` | `admin` may manage people and access |

They're edited on the **People & powers** tab. None of them were changed.

### `member`

A person whose access is entirely per-dashboard can legitimately hold no role at
all — but the coarse `Role=` backstop in `_redirects` can only match on roles,
so they'd be bounced before the edge gate ever ran. `member` means "a known,
signed-in person with no particular job function". The admin screen adds it
automatically to anyone granted dashboards who has no other role, so it never
needs managing by hand.

It's deliberately *not* added to people who already hold a role, which keeps the
existing carve-out intact: `contractor` stays out of the `_redirects` baseline,
so contractors only reach dashboards that name the role explicitly even if the
edge gate were to fail open.

## Failure behaviour

A blob read failure drops the caller onto the role fallback, which is at least
as strict as their grant would have been — a failed read can never widen
access. An unknown slug is denied rather than defaulting open.

## Tests

```
npm run test:access
```

Covers the empty-list-means-nothing case, the no-record fallback, admin bypass,
and a round-trip proving `seedGrantsFromRoles` moves nobody.
