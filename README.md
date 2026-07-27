# nfc-lab

Webflow export of the NFC Lab marketing site, served as static files by Caddy
on Railway (project `nfc-lab`, service `web`). Serving config lives in
[Caddyfile](Caddyfile); everything else is exported output and gets overwritten
by the next Webflow export.

A second Railway service, `forms`, handles form submissions — see
[Forms](#forms). Caddy proxies `/api/*` to it, so the site stays a single
origin with one domain and one certificate.

## Password protection

The site is behind HTTP basic auth. Webflow's own password protection does not
survive an export — the exported `401.html` posts to `/.wf_auth`, an endpoint
that only exists on Webflow's hosting — so the gate is enforced by Caddy
instead. Visitors get the browser's native credential prompt, and `401.html` is
served to anyone who dismisses it.

Two service variables on Railway drive it:

| Variable | Required | Notes |
| --- | --- | --- |
| `SITE_PASSWORD_HASH` | yes | bcrypt hash of the password |
| `SITE_USER` | no | username, defaults to `nfclab` |

`SITE_PASSWORD_HASH` has no fallback on purpose. If it is missing, Caddy
rejects the config and the deploy fails — a broken deploy is the right failure
mode for a missing password, since the alternative is the site silently going
public.

To change the password, generate a new hash and update the variable:

```bash
caddy hash-password --plaintext 'the-new-password'
```

Only the hash goes into Railway. Never commit either value.

`/health` is deliberately left unauthenticated so Railway's healthcheck can
reach it before a deploy is promoted.

## Forms

Every form on the site was dead. Webflow's bundled `js/webflow.js` intercepts
each submit and posts it to `https://webflow.com/api/v1/form/<site-id>`, which
only accepts submissions originating from Webflow-hosted domains. Self-hosted,
every submission landed in the export's own "Oops! Something went wrong" branch
— including the only contact form.

Submissions now go to the `forms` service instead:

| File | Role |
| --- | --- |
| [api/server.js](api/server.js) | The service: validates, rate-limits, emails |
| [js/forms.js](js/forms.js) | Takes the forms over from `webflow.js` in the browser |
| [support/thank-you.html](support/thank-you.html) | Confirmation page for the no-JavaScript path |
| [tools/dev-server.mjs](tools/dev-server.mjs) | Local stand-in for the Caddy routing |

Three forms are wired up. Each posts to `/api/forms/<name>`, and the name
selects a server-side schema:

| Page | Endpoint | Required |
| --- | --- | --- |
| [support/contact-2.html](support/contact-2.html) | `/api/forms/contact` | first name, last name, email |
| [pricing/pricing-1.html](pricing/pricing-1.html) | `/api/forms/pricing-quote` | email |
| [pricing/pricing.html](pricing/pricing.html) | `/api/forms/pricing-plan` | email |

### Service variables

Set these on the `forms` service:

| Variable | Required | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Without it, submissions are logged but never emailed |
| `FORM_FROM_EMAIL` | yes | Must be on a domain verified in Resend |
| `FORM_TO_EMAIL` | no | Where leads land, defaults to `hello@thelabgroup.com` |
| `FORM_WEBHOOK_URL` | no | Optional second sink (Slack, Zapier) — failures here never block the email |
| `ALLOWED_ORIGINS` | no | Comma-separated origin allowlist; unset allows any |
| `RATE_LIMIT_MAX` | no | Accepted submissions per IP per window, default 5 |
| `RATE_LIMIT_BURST_MAX` | no | All requests per IP per window, default 40 |

The two rate limits are separate on purpose: only submissions that pass
validation spend the strict budget, so someone mistyping their email five times
does not lock themselves out, while a bot hammering the endpoint still gets cut
off. Both are in-process, so they assume a single replica.

Every submission is logged as structured JSON *before* delivery is attempted.
If Resend is down, the lead is still recoverable from the service logs, and the
visitor is told to email directly rather than being shown a false success.

### First deploy

The service does not exist yet. To create it:

1. Add a service to the `nfc-lab` project from this repo, set its root
   directory to `api/` and name it **`forms`** — the name is what
   `forms.railway.internal` in the Caddyfile resolves to. Override
   `FORMS_UPSTREAM` on the `web` service if you name it something else.
2. Set `RESEND_API_KEY` and `FORM_FROM_EMAIL` on it.
3. Redeploy `web` so it picks up the new Caddyfile.

Private networking is runtime-only and IPv6-only on older environments, which
is why the service binds `::` rather than `0.0.0.0`. Both services must sit in
the same project *and* environment for the internal hostname to resolve.

### Local development

```bash
npm --prefix api start          # the forms service on :3000
node tools/dev-server.mjs       # the site on :8080, proxying /api/* to it
npm --prefix api test           # unit + end-to-end checks
```

The dev server reproduces the two routing rules that matter (`/api/*` proxying
and `try_files` extension fallback) but deliberately not basic auth, caching or
the security headers — those are Caddy's job.

### After a Webflow re-export

A re-export overwrites the three form pages and reverts all of this silently:
the forms will look fine and submit to nothing. Each one needs its `action`,
`method="post"`, `data-form`, honeypot and `js/forms.js` script tag re-applied.

Two things in those pages are deliberate departures from the export and should
be preserved:

- **The pricing forms collect an email address.** As exported they captured
  only radio selections, so a submission arrived with no way to reply to it.
- **Radio and select values are meaningful.** The export gave every radio
  `value="Radio"` and options `value="First"`, `value="Second"` — a submission
  read `Business type: First`. Values now carry the visible label. Fixing this
  also cleared duplicate `id` attributes the export shipped with.

## Site search

Webflow's site search is a hosted feature — on Webflow's servers `/search`
renders the results itself. An export keeps the search form but ships no
results markup and has no backend behind it, so every search came back empty.
Search is done in the browser instead:

| File | Role |
| --- | --- |
| [tools/build-search-index.js](tools/build-search-index.js) | Generates the index from the exported HTML |
| [search-index.json](search-index.json) | The generated index, committed so the deploy stays static |
| [js/site-search.js](js/site-search.js) | Reads the index, ranks matches, renders results |
| [css/site-search.css](css/site-search.css) | Styles for the results list |

**Re-run the builder after every Webflow re-export**, then commit the result —
otherwise results keep describing the previous version of the site:

```bash
node tools/build-search-index.js
```

It needs no dependencies and writes `search-index.json`. Pages are excluded
either by the list at the top of the script (error pages, scratch and duplicate
template pages) or automatically, when they carry `noindex` or have almost no
body text.

A re-export also **overwrites `search.html` and drops the two lines that load
the search**, which fails silently — the page still renders, it just never
returns anything. Re-add them:

```html
<link href="css/site-search.css" rel="stylesheet" type="text/css">  <!-- in <head> -->
<script src="js/site-search.js" type="text/javascript"></script>    <!-- before </body> -->
```

Nothing on the site links to `/search` — the form only exists on the search
page itself, so the page is reachable only by typing the URL. Adding an entry
point to the nav is a design decision that has not been made.

## Checking config changes before pushing

Railway pins Caddy to the latest 2.x. The Caddyfile can be validated locally
against the same major version:

```bash
PORT=8080 SITE_PASSWORD_HASH='<any bcrypt hash>' \
  caddy validate --adapter caddyfile --config Caddyfile
```

Two ordering rules matter when editing the site block, because Caddy sorts
directives by its own table rather than by file order:

- `try_files` sorts **before** `handle`, and with no matching file it rewrites
  to the last candidate. Left at the top level it would turn
  `POST /api/forms/contact` into a request for
  `/api/forms/contact/index.html` before the proxy ever saw it — which is why
  the static branch is wrapped in a catch-all `handle`.
- `respond` sorts **after** `handle`, so the `/health` route has to be its own
  `handle` block rather than a bare `respond`.
