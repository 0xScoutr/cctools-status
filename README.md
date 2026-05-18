# cctools-status

Public status page for the CCTools API at **status.cctools.network**.

Pure static site (HTML + CSS + vanilla JS, zero build step) deployed via
**Cloudflare Pages** for independent infrastructure — when the main
cctools2 frontend or the cctools2 backend is down, this page stays up
and surfaces the outage to visitors.

## Why a separate static site (and not pm2 or the same Next.js app)

| Hosted as | Isolation from cctools2 | Verdict |
|---|---|---|
| Page inside `cctools2/frontend` | NONE — same Cloudflare Worker | ❌ Anti-pattern |
| `pm2 start status-app` on Hetzner | NONE — same physical box as backend | ❌ Anti-pattern |
| Cloudflare Pages static (this) | FULL — different infra, different edge | ✅ Best practice |

When you visit status.cctools.network, your browser loads ~10KB of HTML/CSS/JS
from Cloudflare's CDN. The JS then fetches
`https://api.cctools.network/api/v1/public/status` directly. If the backend
is down, the page shows a clear "Cannot reach API" banner with the
last-known state from `localStorage`.

## Structure

```
cctools-status/
├── index.html        — main page, semantic HTML + og/twitter meta
├── favicon.ico       — copied from cctools2/frontend/public
├── _headers          — Cloudflare Pages CSP + caching headers
├── README.md         — this file
└── assets/
    ├── styles.css    — hand-rolled CSS matching cctools-native theme
    └── script.js     — fetch + render + 30s poll + localStorage fallback
```

No `package.json`. No dependencies. Just static files.

## Deploy to Cloudflare Pages (one-time setup)

1. Push this folder to its own repo (e.g. `cctools-status`) or import
   directly via the Cloudflare dashboard.
2. Cloudflare Dashboard → **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (leave empty)
   - **Build output directory:** `/` (root of the repo)
4. Save and deploy. Pages picks a `*.pages.dev` URL by default.

## Custom domain

1. Project settings → **Custom domains** → **Set up a custom domain**.
2. Enter `status.cctools.network`.
3. Pages auto-creates the DNS CNAME (if cctools.network is on the same
   Cloudflare account). Done.

If you already added a manual CNAME or Worker Route for status.cctools.network,
**remove those first** — they conflict with the Pages-managed domain.

## Local dev

No build step. Open `index.html` in a browser, OR run a tiny static
server:

```bash
cd cctools-status
python -m http.server 8080
# visit http://localhost:8080
```

JS will fetch from prod `api.cctools.network` — CORS is open on that
endpoint (`Access-Control-Allow-Origin: *`).

## Updating

Push to main → Cloudflare Pages auto-deploys (~30s). Edit and ship; no
node_modules, no lockfile, no framework upgrade surprises.

## Why the data source matters

The page calls `GET https://api.cctools.network/api/v1/public/status`.
That endpoint is served by the cctools2 backend (`pm2` on Hetzner) and
fed by the in-process health checker
(`lib/core/health-checker.ts`) which pings 11 endpoints every 120s
through localhost loopback.

If the backend itself is down, this page **knows it** because the fetch
fails — and it surfaces that to the visitor via the offline banner.
That's the whole point of decoupling: a status page that can't reach
the thing it monitors is the strongest signal of an outage.
