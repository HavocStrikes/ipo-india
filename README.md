# IPO India — Live Tracker & Scorecard

A modern, dark-first, zero-dependency web app for **Indian IPOs (Mainboard + SME)** —
curated like Groww: **upcoming issues from the next month, currently open issues, and
issues listed in the last month**, each with a full details page and a transparent
**0–100 Investability Score** showing whether an IPO is worth applying for.

## UI

- Premium fintech design: **dark mode by default** (+ light mode toggle, remembered + respects system preference), Inter + Space Grotesk type system, SVG icon set, glassy sticky header, animated gradient hero, sliding-pill tabs, gradient score rings with tick marks, staggered card entrances, and full `prefers-reduced-motion` support.
- **`/`** — home hub: stat chips, tabs, search, Mainboard/SME filter, sorting, score-ring cards.
- **`/ipo/:id`** — dedicated details page: hero with quick-fact tiles + copy-link, glowing score ring, animated timeline (open → close → allotment → refund → credit → listing), 5-pillar score breakdown, subscription bars, financials, valuation ratios, listing-day trading, issue objects, promoters, anchors, reviews and registrar/lead managers.
- **"Company in charts"** — every details page opens with a visual section (hand-rolled SVG, no chart library): a financials bar chart (revenue / EBITDA / profit / net worth / borrowings), profitability & returns meter bars, a price-journey line chart with the 52-week range shaded, and an issue-structure donut (fresh vs offer-for-sale) or use-of-funds bars. Chart cards render only when the data exists — IPOs that haven't listed yet simply show no chart section.
- **Subscribe** — an email capture card on the home and IPO pages: visitors pick what they want (upcoming IPO alerts, weekly digest, deep-dive analysis) and submit via `POST /api/subscribe`. Emails are stored server-side in `data/subscribers.jsonl` (git-ignored), with server-side validation, per-IP rate limiting (8/hour), a branded **welcome/confirmation email** with a signed one-click unsubscribe link (when a mail provider is configured — see *Email delivery* below), a public subscriber-count endpoint for social proof, and a `send-update.js` CLI to broadcast future updates.

## Run

```bash
cd ipo-india
npm start          # → http://localhost:8787
```

Requires Node 18+ (uses built-in `fetch`). No npm packages needed.

Environment options:

| Variable          | Default | Meaning                                   |
| ----------------- | ------- | ----------------------------------------- |
| `PORT`            | `8787`  | HTTP port                                 |
| `REFRESH_MINUTES` | `10`    | How often live data is re-fetched         |
| `HISTORY_YEARS`   | `1`     | Years of listed-IPO history to keep       |
| `WINDOW_DAYS`     | `31`    | Curated window for upcoming/listed/closed |

## Run on Cloudflare Workers (free, always-on, no PC needed)

The same app runs as a Cloudflare Worker — cron triggers replace the Node
refresh timer, Workers KV replaces the in-memory cache and the subscriber
file, and `public/` is served as static assets. The Node server
(`server.js`) keeps working unchanged for local use.

```bash
npx wrangler login                    # one-time browser auth (free account)
npx wrangler kv namespace create DATA # prints an id — paste it into wrangler.jsonc
npx wrangler deploy                   # → https://ipo-india.<your-subdomain>.workers.dev
```

Free-plan fit (no card required): 100k requests/day, KV 100k reads + 1k
writes per day, 50 subrequests/invocation. The cron rebuild stays inside
those limits by refreshing the current year every 10 minutes, the previous
year every ~6h, and rotating deep-history "notable" years one per run.

Email (optional, same providers as the Node version):

```bash
npx wrangler secret put RESEND_API_KEY    # or SENDGRID_API_KEY / BREVO_API_KEY
npx wrangler secret put MAIL_FROM         # "no-reply@yourdomain.com"
npx wrangler secret put SUBSCRIBE_SECRET  # random string; signs unsubscribe links
```

### Automatic IPO alerts (Mainboard-only)

Once a provider secret is set, the Worker sends branded score-analysis emails
automatically — **strictly for Mainboard IPOs; SME / NSE Emerge / BSE SME
issues are never emailed**, so your provider quota isn't wasted:

| Email | Trigger |
| ----- | ------- |
| 🔔 Open | a Mainboard IPO's bidding opens (score + 5-pillar breakdown) |
| 📊 Listed | a Mainboard IPO lists (with listing open price and gain%) |

Each email carries the 0–100 score, the 5-pillar breakdown, the
price band and issue size, and a CTA straight to the IPO detail page
(`${SITE_URL}/ipo/:id`). Subscribers pick which emails they want with the
preference checkboxes on the subscribe form; every message has a signed
one-click unsubscribe link.

**Dedup & safety rails:**
- KV tracks notified IPO IDs — no subscriber ever gets the same event twice.
- A cold start seeds the notified lists with everything already open/listed, so
  a fresh deploy never blasts historical IPOs.
- Failed sends retry up to 5 times, then give up (and log a warning) instead of
  looping forever.
- The pipeline runs on odd 10-minute cron slots, capped to 10 Brevo calls and a
  hard ceiling of 16 subrequests per run — well inside the 50-subrequest
  free-plan limit.

Monitor at `GET /api/alerts/status`.

Local dev with real upstream data: `npm run worker:dev` (port 8788), then
open http://localhost:8788. Trigger the cron handler manually with
`curl 'http://localhost:8788/__scheduled?cron=*/10+*+*+*+*'` (needs
`--test-scheduled`, already in the `worker:dev` script).

## Host the frontend on GitHub Pages (hybrid)

The repo doubles as a GitHub Pages source: **Pages serves the static UI, while
the Worker keeps doing everything a static host can't** — live upstream
fetching, KV storage and email. Pushing to `main` runs
`.github/workflows/pages.yml`, which deploys `public/` to Pages automatically.

One-time setup:

```bash
gh repo create ipo-india --public --source=. --push   # or add a remote manually
npx wrangler deploy                                   # note the printed Worker URL
gh variable set IPO_API_BASE --body "https://ipo-india.<your-subdomain>.workers.dev"
gh workflow run "Deploy frontend to GitHub Pages"     # redeploy with the API URL
```

Enable Pages once if it isn't already: **Settings → Pages → Build and release
from GitHub Actions**. The workflow rewrites the `apiBase` in
`public/config.js` from the `IPO_API_BASE` repo variable at deploy time, so the
same `public/` build serves from both hosts:

| Host                | URL                                        | Serves                                            |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| GitHub Pages        | `https://<user>.github.io/ipo-india/`      | static UI, API calls go cross-origin to the Worker |
| Cloudflare Worker   | `https://ipo-india.<your-subdomain>.workers.dev` | UI + API together, always current            |

Pages caveat: static hosts have no SPA fallback, so a *refreshed or shared*
`/ipo-india/ipo/:id` link bounces home via `public/404.html` (in-app navigation
is unaffected). Full deep links work on the Worker URL — use it for sharing.

## Curated windows (Groww-style)

- **Upcoming** — IPOs whose bid opens within the next 31 days (default tab).
- **Open** — bidding is live right now.
- **Closed** — bids closed within the last 31 days.
- **Listed** — listed within the last 31 days.

A "View full archive" toggle (`?all=1`) reveals the complete history for power users.
Today's date drives all windows, so the site always feels current.

## Data sources (live)

- **Chittorgarh public JSON report feeds** (the same JSON their site loads):
  schedule/dates (report 7), performance & listing (125), subscription breakdown (98),
  financials (161), KPI/valuation (162), review votes (104), anchor allotments (156),
  plus the current + previous year.
- **Chittorgarh IPO dashboard timetable** (`/ipo/ipo_dashboard.asp`, Mainboard + SME
  HTML pages) — the JSON reports above can lag by days for brand-new IPOs, so the
  live timetable is scraped as well: it backfills missing open/close dates and adds
  schedule-only records for issues the reports don't know about yet (financials,
  subscription, etc. flow in once the reports catch up or via the detail scraper).
- **Per-IPO detail pages** are scraped server-side (cached 30 min) for price band,
  lot size, issue structure, objects of the issue, promoters, registrar, lead managers
  and listing-day trading stats.

Upstream data refreshes every 10 minutes (stale-while-revalidate, so responses stay
instant) and the frontend re-pulls every 5 minutes. A green "live" pill shows freshness.

## The score

`Score = Demand (25) + Fundamentals (25) + Valuation (20) + Performance (15) + Sentiment (15)`
with an SME risk haircut (×0.88). Scores are informational only — the site and
its emails never suggest whether to apply, hold or avoid. Every pillar degrades gracefully
when data is missing, and each IPO reports a `confidence` level (high/medium/low) based on
how many pillars had real inputs.

## Email delivery

Subscriptions are always **saved** to `data/subscribers.jsonl`. To actually *send*
the "you're signed up" confirmation email (and future broadcasts), configure any
ONE HTTP email provider via env vars — no SMTP libraries, no npm packages:

| Variable           | Example                                  | Provider     |
| ------------------ | ---------------------------------------- | ------------ |
| `RESEND_API_KEY`   | `re_xxxxxxxx`                            | resend.com   |
| `SENDGRID_API_KEY` | `SG.xxxxxxxx`                            | sendgrid.com |
| `BREVO_API_KEY`    | `xkeysib-xxxxxxxx`                       | brevo.com    |
| `MAIL_FROM`        | `IPO India <no-reply@yourdomain.com>`    | required with any key — must be a sender/domain verified in that provider's dashboard |
| `SITE_URL`         | `https://yourdomain.com`                 | public URL used in email links (default `http://localhost:8787`) |
| `SUBSCRIBE_SECRET` | any long random string                   | signs unsubscribe links (default is a dev constant) |

Example (Resend):

```bash
RESEND_API_KEY=re_xxx MAIL_FROM="IPO India <hello@yourdomain.com>" SITE_URL=https://yourdomain.com npm start
```

Without a configured provider nothing breaks — subscriptions still save, the
server logs `[mail] no email provider configured…` at boot, and the subscribe
card honestly says the confirmation couldn't be emailed.

**Broadcasting updates to subscribers later** (`send-update.js`, zero-dependency):

```bash
node send-update.js --dry-run                                        # preview recipients + provider
node send-update.js --subject "3 IPOs open this week" --file mail.html
node send-update.js --subject "Hello investors" --text "Plain-text update"
node send-update.js --subject "Test" --text "Hi" --only you@example.com   # safe single test first
```

Every email (welcome + broadcast) carries a signed one-click unsubscribe link
(`GET /api/unsubscribe?email=…&token=…`) that removes the address from the store.

### Deliverability — getting into Gmail's Primary tab (not Promotional)

The code sends the right headers (`List-Unsubscribe` per RFC 8058,
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `Precedence: list`,
`X-Auto-Response-Suppress: All`) — Gmail reads these as strong "transactional
notification" signals. But headers alone won't do it; the **sending domain** must
be authenticated, or Gmail will file you under Promotional regardless.

Do all three:

1. **Use a custom domain in `MAIL_FROM`** — never a free address (`@gmail.com`,
   `@yahoo.com`, `@outlook.com`). Buy a domain (≈$10/yr) and use
   `no-reply@yourdomain.com`. This is the single biggest lever.
2. **Verify the sender domain in your provider's dashboard** — Brevo:
   *Senders and IP* → *Domains* → add domain → it gives you DNS records to add.
3. **Add the SPF + DKIM + DMARC DNS records** your provider gives you. They
   prove you own the domain and are authorized to send mail from it. Without
   them, Gmail treats you as unauthenticated → Promotional/Spam.

Once those are in place (DNS propagation takes a few minutes to 48h), Gmail
starts trusting the `List-Unsubscribe` header and routes your alerts to the
Primary tab. Until then, the emails still *arrive* — just under Promotional.

### Automatic Mainboard IPO alerts (Worker)

On the Worker, the 10-minute cron also runs a **Mainboard-only alert pipeline**
(on odd slots, to stay inside free-plan subrequest limits) built from
`worker/src/mainboard-alerts.js`. It watches the refreshed dataset for
lifecycle transitions and emails subscribers — **SME / NSE Emerge / BSE SME
issues are skipped entirely**, so daily email quotas are never wasted.

| Email            | Trigger                                                            |
| ---------------- | ------------------------------------------------------------------ |
| 📡 **Open**      | A **Mainboard** IPO's status flips to *open* (≤1 day old)          |
| 📊 **Listed**    | A **Mainboard** IPO lists, with issue vs listing price (+/-%)      |

Each alert is a **neutral, informational analysis** — it states the facts of an
issue and why the model scores it the way it does, and explicitly does *not*
advise readers to buy or apply. In emails:

- **Issue at a glance** — price band, face value, lot size, estimated minimum
  investment for one lot, issue size, exchanges, and the full date table
  (open / close / allotment / listing).
- **Investability score** — 0–100 score and model confidence (never advice).
- **Score breakdown** — all five pillars (Demand, Fundamentals, Valuation,
  Performance, Sentiment) *with the rationale note for each* (e.g.
  *"RoNW 47.17%, PAT margin 9.78%"*), the reason the score reads the way it does.
- **Financial & valuation snapshot** — revenue, PAT, net worth, post-issue P/E,
  RoNW, PAT margin and EPS (pre/post), pulled from the full `records:<year>`
  dataset (not the stripped list summaries).
- **Listing-day outcome** (listed emails) — listing price vs issue price, gain
  or loss %, and the subscription multiple.
- A **Read the full analysis →** button to `${SITE_URL}/ipo/${id}`, a signed
  one-click unsubscribe link, and a footer disclaiming that the message is
  informational and not investment advice.

Each event IPO is also enriched with the scraped detail page (price band,
lot size, timetable) via the shared `detail:<id>` KV cache, so the pricing and
lot-size figures in emails are real.

**Strict category filtering** — `ipo.category.toLowerCase() === 'mainboard'`
gates every step (event detection, email build, dispatch). SME issues never
trigger an alert.

**State tracking (KV `env.DATA`)** — `notified_open_ipos` and
`notified_listed_ipos` record every IPO ID that has been successfully
dispatched, so the same open/listed event never sends twice. IDs are recorded
*only after a successful send* — if all sends fail (e.g. provider error), the
event stays unnotified and automatically retries on the next cron.

**Pacing** — sends are budgeted per run (`min(8, floor(40 / subscribers))`)
to stay well under Cloudflare's 50-subrequest cron cap (KV reads + Brevo API
calls both count).

**Graceful fallbacks** — the pipeline exits cleanly without crashing if
`BREVO_API_KEY` / `MAIL_FROM` is missing (`{ reason: 'no_provider' }`) or if
no subscribers exist (`{ reason: 'no_subscribers' }`).

**Setup:**
```bash
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put MAIL_FROM        # "IPO India <no-reply@yourdomain.com>"
```

Ops visibility: `GET /api/alerts/status` (no PII — counts only).


## API

| Endpoint             | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `GET /api/ipos`      | List (windowed by default). Query: `status`, `category`, `q`, `all=1` |
| `GET /api/ipos/:id`  | One IPO: full record + score pillars + scraped detail   |
| `GET /api/meta`      | Freshness, per-status counts, upstream errors           |
| `GET /healthz`       | Liveness probe                                          |
| `POST /api/subscribe` | Subscribe for updates — JSON `{ email, preferences }`  |
| `GET /api/subscribers/count` | How many people subscribed (no emails exposed)  |
| `GET /api/alerts/status` | Mainboard-alert ops view (mail configured, notified counts, subscribers) |
| `GET /api/unsubscribe` | One-click unsubscribe (signed link from emails)      |

## Disclaimer

Educational tool — **not investment advice**. Scores are rule-based heuristics over
public data; always read the RHP/DRHP before investing.
