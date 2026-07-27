# TODO

## Attach a custom domain (e.g. nfclab.co)

The site currently serves from the generated Railway domain
`https://web-production-0f605.up.railway.app`. That works, but the public site
should launch on the real domain.

Current setup: Railway project `nfc-lab`, service `web`, env `production`,
building `thelabgroup/nfc-lab@main` with Railpack (static → Caddy), auto-deploy on push.

**Why it matters**
- SEO: `*.up.railway.app` is on the Public Suffix List, so it accrues no domain
  authority and is treated as a separate site from anything else we own.
- The export already references `nfclab.co` 16 times; canonical tags and OG URLs
  point at the real domain, so shares/crawlers resolve away from the Railway URL.
- Trust: a Railway subdomain on a payments-adjacent marketing site reads as staging.
- Portability: moving off Railway later breaks every inbound link to the subdomain.

**Blocked on** — do NOT attach the domain until these are done, or Google will
index a broken one-page site on the primary domain:
- [ ] Fix navigation in Webflow and re-export. 647 internal links currently point
      at `index.html`; 25 pages (all of `product/` and `solutions/`, the `company/`
      blog pages, `search.html`) are orphaned — reachable by URL but linked from
      nothing.

      **Caveat — a stopgap was patched into the export, not into Webflow.** On
      branch `fix/image-404-filename-spaces` the worst of the dead nav was fixed
      directly in the exported HTML: the homepage venue carousel now links to the
      5 `solutions/*` pages it names, a new "Ordering products" section on
      `index.html` links to the 4 `product/*` pages, every "Contact sales" button
      on `solutions/*` and `product/*` points at `support/contact-2.html`, and the
      cookie-banner "Privacy Policy" link points at `footer/privacy-policy.html`.
      This cut the orphan set from 25 pages to **14** and took homepage-reachable
      pages from 5 to 20. **A Webflow re-export will silently revert all of it**,
      exactly like the forms and search work (see the README) — the durable fix
      still belongs in the Webflow nav. Until then, re-apply these edits after
      every re-export, or port the link targets into Webflow and drop the stopgap.
      The 40 `index.html` mega-menu/footer links were left untouched on purpose:
      every item is labelled "Coming soon" and none maps to a page on disk.
      Still orphaned after the stopgap (14): the 6 remaining `solutions/*` venue
      pages (`airports`, `bars-clubs`, `cafes`, `entertainment`, `pubs`,
      `rentals`), held back pending a decision on extending the carousel to all
      11; `search.html` (no nav entry point, a design call not yet made); the
      `401`/`404` error pages and `support/thank-you.html` (reached via Caddy and
      the form POST redirect, not links — correct); and template leftovers
      (`company/blog-section`, `footer/stuff-from-homepage`,
      `pricing/pricing-1-copy`, `pricing/pricing`).

**Steps to attach (~2 min once unblocked)**
- [ ] Decide the exact hostname (apex `nfclab.co`, `www`, or both with a redirect).
- [ ] Generate the domain on the Railway `web` service (project `nfc-lab`,
      env `production`) — `generate_domain` with the custom hostname, or the
      dashboard. Requires a re-authenticated Railway session (MCP auth expired
      during setup — re-auth with `railway login`).
- [ ] Add the CNAME record Railway returns at the DNS provider. Apex domains need
      a provider that supports CNAME flattening / ALIAS, or use `www` + redirect.
- [ ] Wait for Railway to issue the TLS cert (automatic), then verify HTTPS resolves.
- [ ] Update any absolute URLs / canonical tags in the export if the chosen
      hostname differs from what Webflow emitted.

## Finish the navigation fix

The dead navigation was patched directly in the export on branch
`fix/image-404-filename-spaces` — carousel links, a new "Ordering products"
section, the `solutions/*` and `product/*` "Contact sales" buttons and the
cookie-banner privacy link (full detail in the caveat under
[Attach a custom domain](#attach-a-custom-domain-eg-nfclabco) above). That took
homepage-reachable pages from 5 to 20 and cut the orphan set from 25 to 14. Two
threads are still open:

- [ ] **Decide whether to surface the 6 remaining venue pages.**
      `solutions/airports`, `bars-clubs`, `cafes`, `entertainment`, `pubs` and
      `rentals` exist and are complete (verified real content, ~1,530 words each,
      not drafts) but are linked from nothing. The homepage carousel lists 5 of
      the 11 venues; extend it to all 11 — or add a venues hub / mega-menu
      section — to wire them in. Icons and copy are already on disk, so this is a
      design/IA call, not new build work.
- [ ] **Move the fix into Webflow (the durable version).** Every link above is a
      post-export edit, and **a Webflow re-export silently reverts all of it** —
      the same failure mode as the forms, company and search work. Either
      re-apply the edits after each re-export, or fix the nav in the Webflow
      project and drop the stopgap. Doing this is what unblocks the "Fix
      navigation in Webflow and re-export" checkbox in the domain section above.

## Populate the company/ pages (blog + newsroom)

The four `company/*` pages shipped empty from Webflow — `blog.html`, `blog1.html`,
`newsroom.html` and `blog-section.html` each had a `<body>` of nothing but script
tags. The same pages are empty on the live site (`nfclab.com/company/blog` etc.),
so nothing was lost in the CMS import; they were never populated in Webflow. They
have now been built from the `solutions/pubs.html` chassis (identical nav, footer,
cookie banner, scripts) using the blog/news classes that already exist unused in
`nfclabtlg.webflow.css` (`.blog-post-item`, `.news-item-big`, `.post-detail-heading`,
`.date-news-wrapper`, `.category-news-*`). Nav wiring: Company → Newsroom now points
at the real page and a new **Blog** entry sits beside it, in both the mega-menu and
footer, across all 20 pages. `tools/build-search-index.js` was re-run so the new
content is searchable (`blog-section.html` excluded via its `noindex`).

**Deliberate choice — the newsroom ships no invented announcements.** Dated press
releases are records of things that actually happened; fabricating them would put
false announcements on the site under NFC Lab's name. So `newsroom.html` renders a
real "No announcements just yet" empty state, with a fully-formed announcement card
sitting commented-out directly beneath it plus swap-over instructions. The page is
publishable today with nothing invented in it. The blog is different: its articles
are genuine NFC explainers (static vs dynamic, NDEF, NTAG memory sizes, encryption,
NFC vs QR, multi-site rollout) and are real content — but their **dates and read
times are editorial placeholders**.

- [ ] Replace the blog post dates and read times with real values before publishing
      (search the pages for `date=`/`read=` origins in the copy, or edit the emitted
      HTML directly).
- [ ] When a real announcement exists, populate `newsroom.html`: delete the
      `.post-empty-state` block and uncomment the `.post-grid` card template beneath
      it (one `.blog-post-item` per release). Do not backfill invented ones.
- [ ] Decide whether the new **Blog** nav/footer item stays; if not, remove it from
      the mega-menu and footer (added across 20 pages alongside the Newsroom link).
- [ ] **A Webflow re-export will silently revert all of this** — the pages, the nav
      wiring and the search index — exactly like the forms, search and nav-stopgap
      work above. The durable fix belongs in Webflow (populate the CMS / fix the
      nav there); until then, re-apply after every re-export.

## Finish wiring up the forms service

Every form on the site now posts to a `forms` service (`api/`), taken over from
Webflow's dead form endpoint by `js/forms.js`. The code, the Caddy `/api/*`
proxy and the tests are all in place and passing — but the service does not
exist on Railway yet, so submissions have nowhere to land in production. See
the [Forms section of the README](../README.md#forms) for the full context.

**Blocked on** — until the service exists and has a Resend key, every
submission is logged but no email is sent, and the visitor is told to email
`hello@thelabgroup.com` directly:
- [ ] Create the `forms` service in the `nfc-lab` project (env `production`)
      from this repo, root directory `api/`. The name **must** be `forms` — it
      is what `forms.railway.internal` in the Caddyfile resolves to. If named
      otherwise, override `FORMS_UPSTREAM` on the `web` service to match.
      (Needs a re-authenticated Railway session — MCP auth expired during setup,
      re-auth with `railway login`.)
- [ ] Set `RESEND_API_KEY` and `FORM_FROM_EMAIL` (must be on a domain verified
      in Resend) on the `forms` service. Optional: `FORM_TO_EMAIL` (defaults to
      `hello@thelabgroup.com`), `FORM_WEBHOOK_URL`, `ALLOWED_ORIGINS`. Full
      table in the README.
- [ ] Redeploy `web` so it picks up the new Caddyfile (the `/api/*` proxy).

**Verify before trusting it**
- [ ] `caddy validate --adapter caddyfile --config Caddyfile` — the Caddyfile
      was restructured for the `/api/*` proxy but could not be validated during
      setup (no local `caddy`/`docker`). Two directive-ordering rules matter;
      see the README's config-changes section. Run once with
      `PORT=8080 SITE_PASSWORD_HASH='<any bcrypt hash>'`.
- [ ] Submit each of the three live forms in production and confirm the email
      arrives: contact (`support/contact-2`), pricing quote (`pricing/pricing-1`),
      site plan (`pricing/pricing`).

## Site search — considerations

Webflow's search is server-rendered; the export shipped the form but no backend,
so every query came back empty. Search now runs in the browser against a
prebuilt index (`js/site-search.js`, `tools/build-search-index.js`,
`search-index.json`). Three things to keep in mind:

- **A re-export silently breaks it, in two ways.** Like the forms and nav work,
  a Webflow re-export overwrites `search.html` and drops the two lines that load
  the search — the page still renders, it just returns nothing. Re-add the
  `css/site-search.css` `<link>` and the `js/site-search.js` `<script>` (see the
  README's Site search section). Separately, the index is a build artefact: it
  does not regenerate itself, so **re-run `node tools/build-search-index.js` and
  commit the result after any content change**, or results describe the previous
  version of the site.

- **Nothing links to `/search`.** The search form only exists on the search page
  itself, so the page is reachable only by typing the URL. Adding an entry point
  (a header/nav search affordance) is a design decision that has not been made —
  decide whether search should be discoverable before launch, or leave it as a
  deep link on purpose.

- **The index is fetched behind the auth gate, and the builder is hidden.** The
  browser fetches `search-index.json` same-origin with credentials, so it works
  through the site's HTTP basic auth; `/tools` is denied in the Caddyfile so the
  build script is never served publicly. If the basic-auth gate is removed at
  launch, re-confirm the fetch still resolves, and keep the `/tools` denial in
  place through any Caddyfile restructure.
