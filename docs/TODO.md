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
