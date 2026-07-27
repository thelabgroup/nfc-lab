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
