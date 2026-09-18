# nfc-lab

Webflow export of the NFC Lab marketing site, served from **Cloudflare Workers
static assets** (Worker `nfc-lab`, account `thelabgroup`). Serving config lives
in [wrangler.jsonc](wrangler.jsonc) and [worker/index.js](worker/index.js);
everything else in the repo root is exported output and gets overwritten by the
next Webflow export.

Form submissions are handled by the same Worker under `/api/*` — see
[Forms](#forms) — so the site is a single origin with one deploy.

## Domains

`nfclab.co` serves the site. Everything else 301s to it, path and query
intact, so search engines index one copy and inbound links all land on one
domain. `CANONICAL_HOST` in [wrangler.jsonc](wrangler.jsonc) names the winner;
`worker/test/canonical.mjs` covers the behaviour, because `wrangler dev`
proxies with its own Host header and cannot exercise it.

| Hostname | |
| --- | --- |
| `nfclab.co` | serves the site |
| `www.nfclab.co`, `nfclab.com`, `www.nfclab.com` | 301 to `nfclab.co` |
| `nfc-lab.dry-sky-b32b.workers.dev` | serves directly — exempt, so the Worker stays reachable while a domain is being changed |

**`nfclab.net` is deliberately not attached.** Its apex is encoded into every
physical NFC tag, so pointing it here would put the marketing site in front of
every scan once the SDM backend is unparked. See
[docs/TODO.md](docs/TODO.md#the-nfc-tag-service-its-domains-and-what-is-left-of-aws).

Adding a hostname means adding it to `routes` **and** to the redirect
expectations in `worker/test/canonical.mjs`. Note that adding `routes` to the
config disables `workers.dev` by default — `workers_dev: true` is set
explicitly to stop that happening again.

The generated `workers.dev` hostname is exempt from the redirect so the Worker
stays reachable while a domain is being changed. That would leave it free to be
indexed alongside `nfclab.co`, so the Worker sends `X-Robots-Tag: noindex` on
any hostname that is not the canonical one.

**Neither the redirect nor the noindex can be tested with `wrangler dev`.** It
reports the hostname as the first configured route, so every local request
looks like it arrived on the canonical host and both branches are dead. A
request sent to the dev server as `bogus.example.com` comes back `200` and
unmarked — indistinguishable from both features being broken. That is what
`worker/test/canonical.mjs` is for; verify the real thing against the deployed
hostnames.

## Sitemap and robots.txt

Webflow generated both on its own hosting and neither survives an export, so
self-hosting lost them silently. [tools/build-site.js](tools/build-site.js)
writes them into `dist/` on every build:

- **`sitemap.xml`** lists every page except the error pages, the post-submit
  confirmation, the search page and the template leftovers. `<lastmod>` comes
  from each file's last commit date — the mtime in `dist/` is worthless, since
  every file was copied moments earlier and would date the whole site to the
  last deploy. Pages carrying their own `noindex` are skipped, because a
  sitemap entry for a noindexed page is a contradiction crawlers report.
- **`robots.txt`** allows everything except `/api/` and `/search.html`, and
  points at the sitemap.

Generated rather than committed on purpose. `search-index.json` is the
cautionary tale: it is a committed artefact that has to be rebuilt by hand
after every re-export, and forgetting leaves search describing the previous
version of the site. These cannot drift that way.

The canonical origin is read out of `wrangler.jsonc`, so `CANONICAL_HOST` and
the URLs in the sitemap cannot disagree.

## How a request is served

Cloudflare uploads an asset directory wholesale, so the deployable site is
staged into `dist/` first by [tools/build-site.js](tools/build-site.js): it
copies the export out of the repo root and leaves behind everything that is not
the site (the Worker, the build scripts, the docs). `dist/` is gitignored and
rebuilt on every deploy.

`run_worker_first` is set, so [worker/index.js](worker/index.js) sees every
request before the asset host answers it. That is what makes the password gate
a gate — with default asset routing, static files are served before the Worker
runs and the whole site would be public. The Worker then does the four things
a bare asset host does not:

| | |
| --- | --- |
| Basic auth | everything except `/health` — see [Password protection](#password-protection) |
| `/api/*` | handled in-process by [worker/forms.js](worker/forms.js) |
| `try_files` | `/solutions/pubs` resolves to `/solutions/pubs.html`, no redirect |
| Headers | the CSP, the cache policy, and the exported 401/404 pages |

```bash
npm install            # once
npm run build          # stage dist/
npm run deploy         # build, then wrangler deploy
npm run dev            # build, then wrangler dev on :8787
npm run tail           # stream production logs
```

## Password protection

**The site is public. The gate is off.** This section is how to put it back.

Webflow's own password protection does not survive an export — the exported
`401.html` posts to `/.wf_auth`, an endpoint that only exists on Webflow's
hosting — so while the site was being prepared the gate was enforced by the
Worker instead: the browser's native credential prompt, with `401.html` served
to anyone who dismissed it.

What takes the gate off is `SITE_PUBLIC` in [wrangler.jsonc](wrangler.jsonc),
and nothing else:

| Name | Where | Notes |
| --- | --- | --- |
| `SITE_PUBLIC` | `vars` | `"true"` serves the site to everyone. Any other value, including unset, keeps the gate |
| `SITE_PASSWORD` | secret | the password itself |
| `SITE_PASSWORD_SHA256` | secret | hex SHA-256 of the password, if you would rather not store it in clear |
| `SITE_USER` | secret or var | username, defaults to `nfclab` |

To put the gate back, delete the `SITE_PUBLIC` line and redeploy. The
`SITE_PASSWORD` secret is still set, so that is the whole procedure:

```powershell
npm run deploy
```

To change the password:

```powershell
"the-new-password" | npx wrangler secret put SITE_PASSWORD
```

That switch is deliberately a committed var rather than the absence of a
secret. Neither password secret has a default, so **with the gate on and no
password set the Worker answers `503` to every request rather than serving the
site** — the same reasoning as the old Caddy config refusing to start on a
missing hash. If "no password" simply meant "public", a mislaid secret would
silently publish the site; instead, publishing it is a line someone added in a
diff. Never commit the password itself.

Caddy verified a bcrypt hash, which is why the old `SITE_PASSWORD_HASH`
variable does not carry over: Workers has no bcrypt, and running one per
request would spend real CPU on every page load. The stored form is a SHA-256
digest instead. The threat model differs from a password database — this is one
site-wide password held as an encrypted secret, not a table of user hashes that
leaks wholesale.

`/health` is deliberately left unauthenticated so an uptime check can reach it
without credentials. It returns `OK` and no site content.

## Forms

Every form on the site was dead. Webflow's bundled `js/webflow.js` intercepts
each submit and posts it to `https://webflow.com/api/v1/form/<site-id>`, which
only accepts submissions originating from Webflow-hosted domains. Self-hosted,
every submission landed in the export's own "Oops! Something went wrong" branch
— including the only contact form.

Submissions are handled by the site's own Worker instead:

| File | Role |
| --- | --- |
| [worker/forms.js](worker/forms.js) | The handler: validates, rate-limits, emails |
| [worker/index.js](worker/index.js) | Routes `/api/*` to it, inside the auth gate |
| [js/forms.js](js/forms.js) | Takes the forms over from `webflow.js` in the browser |
| [support/thank-you.html](support/thank-you.html) | Confirmation page for the no-JavaScript path |
| [api/server.js](api/server.js) | A node:http adapter over the same handler, for local dev and the tests |
| [tools/dev-server.mjs](tools/dev-server.mjs) | Local stand-in for the production routing |

`worker/forms.js` holds all of the behaviour and is platform-neutral — it takes
a `Request` and an env bag and returns a `Response`. The Worker calls it
directly; `api/server.js` is a thin adapter so the suite in `api/test` can
exercise the same code on a bare Node install, without wrangler in the loop.

Three forms are wired up. Each posts to `/api/forms/<name>`, and the name
selects a server-side schema:

| Page | Endpoint | Required |
| --- | --- | --- |
| [support/contact-2.html](support/contact-2.html) | `/api/forms/contact` | first name, last name, email |
| [pricing/pricing-1.html](pricing/pricing-1.html) | `/api/forms/pricing-quote` | email |
| [pricing/pricing.html](pricing/pricing.html) | `/api/forms/pricing-plan` | email |

### Secrets and variables

Set these on the `nfc-lab` Worker (`npx wrangler secret put <NAME>`):

| Name | Required | Notes |
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
off.

They are enforced by Cloudflare's Rate Limiting bindings (`FORM_BURST_LIMIT`,
`FORM_SUBMIT_LIMIT` in [wrangler.jsonc](wrangler.jsonc)), which count per
Cloudflare location rather than per isolate. That matters now that the site is
public: the endpoint used to sit behind the password gate, where an
isolate-local counter was defence in depth rather than the only thing between a
bot and the inbox. The in-process counters are still there as the fallback for
`api/server.js` and the tests, which drive them through `RATE_LIMIT_MAX`.

The binding's period may only be 10 or 60 seconds, so the strict tier is now
"5 per minute" rather than the old "5 per 10 minutes" — quicker to recover
from, and still far below what makes a bot worth its time.

Worth knowing: the honeypot and the sub-1.5s fill check are the only other
spam defences, and both are trivial for a determined bot. If the forms start
attracting junk now that they are public, Turnstile in front of
`/api/forms/*` is the next step.

Every submission is logged as structured JSON *before* delivery is attempted.
If Resend is down, the lead is still recoverable from the service logs, and the
visitor is told to email directly rather than being shown a false success.

### Before trusting it in production

The handler ships with the Worker, so there is no separate service to create —
but until `RESEND_API_KEY` and `FORM_FROM_EMAIL` are set, every submission is
logged and nothing is emailed, and the visitor is told to email
`hello@thelabgroup.com` directly. `GET /api/health` reports which state it is
in:

```json
{ "ok": true, "emailConfigured": false, "forms": ["contact", "pricing-quote", "pricing-plan"] }
```

Every submission is logged as structured JSON *before* delivery is attempted,
so if Resend is down the lead is still recoverable with `npm run tail`.

### Local development

Two ways round, depending on what is being changed:

```bash
npm run dev                     # the real path: Worker, auth, headers, /api/* on :8787
```

```bash
npm --prefix api start          # the forms handler alone on :3000
node tools/dev-server.mjs       # the site on :8080, proxying /api/* to it
npm test                        # unit + end-to-end checks
```

`wrangler dev` runs the deployed code exactly as production does, including the
auth gate — put the password in a `.dev.vars` file (gitignored) as
`SITE_PASSWORD = "..."`. The node pair is faster for content work and needs no
wrangler; it reproduces the two routing rules that matter (`/api/*` and the
`try_files` extension fallback) but deliberately not basic auth, caching or the
security headers.

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

A dry run builds `dist/`, bundles the Worker and validates
[wrangler.jsonc](wrangler.jsonc) against its schema without uploading anything:

```powershell
npm run build
npx wrangler deploy --dry-run
```

Then check the routing itself with `npm run dev`, because these three settings
are load-bearing and each fails quietly if changed:

- **`run_worker_first: true`** — without it the asset host answers static paths
  before the Worker runs, the auth gate never sees them, and **the site is
  public**. The symptom is a `200` on `/` with no credentials.
- **`html_handling: "none"`** — the default (`auto-trailing-slash`) makes the
  asset host redirect `/solutions/pubs.html` to `/solutions/pubs`. Every
  internal link in the export carries the `.html`, so the default turns each
  one into an extra redirect hop. `"none"` makes `env.ASSETS.fetch` an
  exact-path lookup and lets `serveStatic()` resolve both forms itself.
- **`not_found_handling: "none"`** — leaves 404s to the Worker, which serves
  the export's own `404.html`.

Worth re-running after any change to the gate:

```powershell
# expect 401 — a 200 here means the site is open to the internet
curl.exe -s -o NUL -w "%{http_code}`n" https://nfc-lab.dry-sky-b32b.workers.dev/
```
