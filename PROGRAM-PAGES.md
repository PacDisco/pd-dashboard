# Program Pages: a visual editor for pacificdiscovery.org/programs/*

Staff edit program pages by clicking on the page itself. Changes autosave as a
draft and go live only when someone publishes. The public pages are built and
served by a **separate** repo and Netlify site, **pd-program-pages**, which never
sees drafts and has no database or login.

```
 pd-dashboard (this repo, behind Netlify Identity)        pd-program-pages (public, static)
 ┌──────────────────────────────────────────┐   publish  ┌──────────────────────────────┐
 │ /program-pages/  visual editor           │──build────▶│ scripts/build.mjs             │
 │ /api/program-pages    drafts, publish,   │   hook     │  GET /api/program-pages-export│
 │                       history (Neon)     │◀───────────│  (Bearer build token,         │
 │ /api/program-media    images (Blobs)     │◀───────────│   published pages only)       │
 │ /api/program-pages-export  token only    │            │ → dist/programs/<slug>/…      │
 └──────────────────────────────────────────┘            └──────────────┬───────────────┘
                                                                        │ fragment.json
                                          Cloudflare Worker on www.pacificdiscovery.org/programs/*
                                          keeps the site header/footer/GTM, swaps in <main>
```

## What's in this repo

| Path | What it is |
|---|---|
| `program-pages/index.html`, `editor.js` | The editor dashboard. Gated like every other dashboard (`dashboard.json`: admin, outreach, programs, admissions). |
| `program-pages/template/render.mjs` | **Pinned copy** of the page template from pd-program-pages. The editor renders with it so the preview matches the live page. Update with `npm run sync:template`. |
| `program-pages/starters/south-america.json` | Starter content taken from the current South America page. Bracketed text like `[Instructor name]` marks what still needs filling in. |
| `netlify/functions/program-pages.mjs` | Drafts, autosave (with conflict detection), publish, unpublish, history, restore, archive. |
| `netlify/functions/program-media.mjs` | Image upload and serving (Netlify Blobs store `program-media`). JPG/PNG/WebP/GIF only, checked by file signature. No SVG. |
| `netlify/functions/program-pages-export.mjs` | Read-only export of **published** pages for the public build. Only accepts the build token. |
| `netlify/functions/_shared/program-pages-access.mjs` | Who can edit and who can publish, plus the build-token check. |
| `MIGRATION-program-pages.sql` | Tables `program_pages` and `program_page_versions`. Idempotent. |
| `scripts/sync-program-template.mjs` | Copies the template from `../pd-program-pages` (or another path or the live site). |
| `test/program-pages.test.mjs`, `test/program-pages.smoke.mjs` | `npm run test:program-pages`, `npm run test:program-pages-ui`. |

`netlify.toml` gains one header block, so the browser can import `template/render.mjs`.
Nothing else in the repo changed.

## Who can do what

- **Edit drafts:** anyone who can open the Program Pages dashboard. This is the same rule as the edge gate (admin, or the person's dashboard grants, or the dashboard's roles if they have no grants yet). `/api/*` is outside the gate, so the functions check it themselves.
- **Publish, unpublish, archive:** editors who also hold `admin`, `outreach` or `programs`. Override with `PROGRAM_PAGES_PUBLISH_ROLES`. Admissions can prepare changes, and someone else publishes them.
- **The build token** can read published pages and images. It can't do anything else, and no Identity session works on the export endpoint.

## Environment variables (pd-dashboard)

| Name | |
|---|---|
| `NETLIFY_DATABASE_URL` | Already set (Neon). |
| `PROGRAM_PAGES_BUILD_TOKEN` | 32+ random characters (`openssl rand -hex 32`). Set the **same value** on pd-program-pages. Under 24 characters disables the export. |
| `PROGRAM_SITE_BUILD_HOOK` | The build hook URL from pd-program-pages → Site configuration → Build hooks. Without it, publishing still saves but the editor warns that the site wasn't rebuilt. |
| `PROGRAM_PAGES_PUBLISH_ROLES` | Optional. Default `admin,outreach,programs`. |

## How editing works

- **Text:** click it and type. Enter finishes a one-line field. Pasting strips formatting.
- **Prices, dates, status, links:** click them on the page and the right-hand panel jumps to that field.
- **Photos:** click one to upload (resized to 2400px in the browser first), reuse an earlier upload, or paste a URL from the existing `/library/images/` folder. A description box sits under every photo.
- **Lists** (weeks, FAQs, dates, cards and so on): **+ Add** buttons sit on the page. A selected item gets a toolbar to move it up or down, duplicate it or delete it.
- **Sections** tab: show, hide and reorder sections per page.
- **Undo/redo** buttons, or Ctrl/Cmd+Z, cover every change, including deletes.
- **Publish** runs a checklist first. Bracketed placeholders in visible sections, a missing tuition and incomplete dates **block** publishing. Missing photo descriptions and a short search description only **warn**. "Show me" links jump to each problem.
- **History:** every publish is kept, and each one can be previewed or restored into the draft.
- **Two editors at once:** saves carry a revision number. If someone else saved in the meantime, you choose to load their version or keep yours.

## Changing the template (adding a field or section)

1. Edit `src/render.mjs` in **pd-program-pages**. Add the field to `SCHEMA` and render it in the matching `R.<section>`. The editor builds its forms from `SCHEMA`, so no editor code is needed.
2. `npm test` there, then deploy.
3. Here, run `npm run sync:template`, review the diff and deploy. Admins see a notice in Page settings whenever the two copies differ.

The template is pinned here rather than loaded from the public site, so nothing served by the public site ever runs inside the dashboard.
