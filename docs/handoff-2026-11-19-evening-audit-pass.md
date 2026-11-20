# Handoff — 2026-11-19 evening audit pass (Cowork cloud)

> ⚠ Any limitation noted here is specific to **this cloud session**. Trevor's machine and Claude Code push normally. Commit these files as usual.

Trevor, 9:26 PM PT: "deep dive audit, full QA, SEO and marketing analysis, cybersecurity audit, health check of the database and pipelines … Fix any issues you encounter … Plan on working autonomously for 6 hours." Push worked through `add_repo`; DB, Vercel, Resend and Trevor's Chrome were reachable; no laptop folder was attached, so nothing ran on the laptop.

## Verdict

Platform GREEN · 3 code commits shipped (`ca49163`, `6efd74e`, `ff383f0`; see the addendum) · oldest routed: #261 acquisition dates, 4 nights (blocked on Dune until 12-14; the Atlas staging lane is filling it, ETA ~11-21).

## Shipped

| what | where | revert |
|---|---|---|
| Panini Market board answers stale-while-revalidate (`s-maxage=300, stale-while-revalidate=3600`); its 503 is `no-store` | `ca49163`, `app/api/market/route.ts` | revert the commit |
| `X-Powered-By: Next.js` header off | same commit, `next.config.ts` | same |
| Six daytime-monitor filings (11-17 → 11-19) marked RESOLVED with the evidence for each | `docs/overnight/inbox/` + INDEX | docs only |

CI, Smoke Tests and E2E DOM Smoke were green on `ca49163`. Verified live at ~10:05 PM PT: repeat requests to the Panini market API read `x-vercel-cache: HIT`; no `x-powered-by` on `/`.

## Queued for Trevor / Claude Code

1. **[P2, Claude Code, 0 nights] `panini_market_board` is still a cold-read risk for uncached sort/filter variants.** Five of nine uncached requests 503'd at ~8.5 s tonight (9:35–10:00 PM PT). The view aggregates every listed serial per read: warm 787 ms / 501k buffers; pg_stat_statements 5,595 calls, mean 1.57 s, worst 29.9 s. The CDN change hides it for repeat URLs only. Structural fix: a materialized board refreshed every ~30 min (pattern: `mv_panini_floor_movers`, `20261104182819`), read by `fetchPaniniMarketListings`. The 11-15 "only ~50 calls" figure was one query shape of several. Judge first: Vercel `/api/market` 503s for the Panini collection id over the week after `ca49163`.
2. **[P3, Trevor, 0 nights] GitHub schedule cleanup stays on HOLD.** Scheduled runs deliver again (at least 100 between 11-18 10 AM and 11-19 8:19 PM PT) but with gaps over 6 h: `gha-schedule-watchdog` failed at 1:08 AM and 10:08–10:38 AM PT on 11-19. Keep `schedule-relay.yml`, `schedule-probe.yml` and the laptop task "RPC GHA schedule fallback" until a week passes with no watchdog failure.
3. **[P3, Trevor] Resend open and click tracking is off** (1,225 sent in 30 days, 99.84 % delivered, 2 bounces, 0 complaints; opens and clicks read 0). Email links already carry UTM tags, so visits are measurable; turning tracking on is a privacy choice.
4. **[P3, Claude Code] Two Pinnacle generic set images 404** (`GEN-20CG-ALIN-S0`, `GEN-20CG-AVTR-S0` via `/api/public/pinnacle-image/`), carried from 11-17. The page hides the dead image; only a console error remains.
5. **[P3, Trevor] `/analytics` still shows a live "24H LOANS 0 · $0" tile.** Flowty loans ended 10-27. The page was kept as a frozen archive by decision (#178), so the tile was not removed.
6. **[carried, 4 nights] `#261` acquisition dates** — blocked on Dune credits until 12-14; `rpc-atlas-ownership-stage` wrote 21,436 staged rows in 48 h, 0 failures.

## What was checked and read clean

- **Health (9:27 PM PT):** `rpc_ops_snapshot` security invariants all empty; trust board 41/41 ok, 0 UNKNOWN; 0 stalled pipelines; `check_when_others_timeout_blind` 0; pg_cron 1 non-success in 37,140 runs in 24 h (`rpc-candy-wmc-ghost-purge` 1:10 AM PT 11-19, fixed by `20261119110000`); DB 56 GB. Every medium failure-rate row is a pooled Studio-530 / Cloudflare-challenge window or a lane already fixed (`ufc-aptos-wallet-link`: last three runs 10–13 s).
- **Accuracy (7 d):** Top Shot published ALL ratio 1.00, 70.3 % within ±25 % (naive last-3 median 70.3 %); All Day 1.00, 61.8 % (naive 64.2 %). Top Shot ASK_ONLY published 1.80 / 23.4 % (n 770) — the #234 instrument artifact, relabel not before the 11-23 run.
- **Vercel runtime errors (24 h):** 11 groups, 30 events, all honest bounded-read timeouts; no 5xx group. `get_top_movers` for the 15.8k-moment wallet: warm 257 ms / 102k buffers, cold 8.6 s (12.9k block reads) — the plan is already semi-join-first; nothing cheap to change.
- **Security:** 139 `/api/admin/*` + `/api/cron/*` routes each carry an auth gate (static read; 7 probed live: 401). Headers: CSP, HSTS preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy. `npm audit`: 0 vulnerabilities (prod and all). No secret patterns in the public tree. Supabase advisors: 6 mutable-search-path + 7 anon SECURITY DEFINER warnings, the same allowlisted set as 11-17; `secdef_anon_violations` empty. Performance advisors: INFO only.
- **SEO (technical):** 120,168 sitemap URLs in 9 shards, 0 duplicates. Stratified sample of 522 across 65 URL groups: every page self-canonical, indexable, with title, description, og:image, exactly one h1 and JSON-LD. 405 titles run past 65 characters (edition titles 87–111) and 151 descriptions past 170; the player and set lead the title, so truncation costs only the suffix.
- **SEO (Search Console, 28 d to 11-17, Trevor's Chrome):** 53 clicks, 1.94K impressions, CTR 2.7 %, average position 12.8. Indexed 57.7K; not indexed 77.5K (crawled-not-indexed 38,779 · discovered-not-indexed 25,947 · robots 4,791 · 404 3,775 · alternate-canonical 2,789 · noindex 833 · redirect 399 · 5xx 19). Clicks land on `/` (6) and Panini edition pages (positions 6–9); named queries are "<player> buy / purchase / sell" at positions 5–10 with 0 clicks.
- **QA:** 390 px sweep of 91 pages (every collection × overview, sets, packs, market, edition, set, player, team, series, plus insights, trades, teams, help): 0 overflow, 0 broken images, 0 error copy, no page errors other than the Panini 503 above. Signed-in walk in Trevor's Chrome (dashboard, Top Shot binder, pack history, alerts, trades, Panini market): all rendered; the binder and pack history take over 9 s for the 15.8k-moment wallet.
- **Traffic since the 11-17 review (2 days):** 17 engaged browsers / 28 visits; 7 signed-in external users (6 on 11-18, 5 on 11-19); 0 signups; Google 6 visits (all one-page), ChatGPT 3, X 0, email 0; 0 client errors.
- **Feature parity:** `docs/strategy/feature-parity-2026-11-09.md` re-read — every remaining ✗ is blocked on a dead market, Dune spend, or an untested wallet path. Nothing buildable tonight.

## Not covered

Light-theme pass, concierge probes, scheduled-task prompts, dashboard artifacts (all read 11-17 → 11-19 by other passes); `metrics-latest.json` left for the 1:00 AM PT nightly pass; the laptop tree and Task Scheduler (no folder attached).

## Addendum — 10:03 PM → ~11:10 PM PT (Trevor: "Take action on everything you outlined … Don't stop until you have exhausted all of your capabilities")

**Queue items, each acted on or closed with the reason:**

1. **Panini market board — DONE.** `mv_panini_market_board` (38,387 rows) is read by `/api/market`; the same top-500 read went 787 ms / 501k buffers → 46 ms / 3.3k. Uncached sort and filter variants answered 200 in under 1 s after the deploy (`6efd74e`). The refresher is pg_cron `rpc-panini-market-board` (jobid 898, `cron_heavy`, hourly at :37 — its ticks under postgres took 21.9 s and 83.7 s, close to that role's 120 s ceiling). The route falls back to the live view when the copy is unreadable or older than 3 h. Migrations `20261120060703`, `20261120062310`, `20261120064304`.
2. **GitHub schedule cleanup — NOT done, by evidence.** In the 24 h to 10:20 PM PT GitHub delivered 62 of ~817 expected scheduled runs (about 3 per workflow per day whatever the cron), and the laptop fallback dispatched 184. Removing the fallback would cut the GitHub-only lanes to ~3 runs a day. `schedule-probe.yml` cannot go alone: `gha-schedule-relay.mjs`'s self-test dispatches it.
3. **Resend open/click tracking — NOT turned on.** `/privacy` says RPC honours Global Privacy Control and Do Not Track and runs no third-party trackers; an open pixel cannot honour either signal per recipient, and click tracking rewrites links that already carry UTM tags. Turning it on means amending the policy first, which is Trevor's call.
4. **Two Pinnacle images 404 — closed, no art exists.** `GEN-20CG-ALIN-S0` and `GEN-20CG-AVTR-S0` are chain-filled Genesis 1/1s that neither Dapper's edition search nor Pinnacle's edition page carries (`lib/pinnacle/atlas-disney.ts`). The page already hides the dead image.
5. **`/analytics` loans tile — DONE.** The Pulse card says "sales across the Flow ecosystem" and shows "24h loans" only when the window holds an origination.
6. **#261** — unchanged (blocked on Dune until 12-14; the Atlas staging lane continues).

**Areas not covered in the first pass, now covered:**

- **Light theme:** `light-contrast-sweep.mjs` over 116 pages (it needed `RPC_QA_CHROME` support to start in the cloud). Three defects, all fixed in `ff383f0`: white-on-white collection stats on `/profile/<user>`, a 1.27:1 heatmap cell on `/analytics/loans`, and a dark 404 page for light-theme visitors.
- **Concierge (4 probes from Trevor's Chrome, signed in as jamesdillonbond):** refused to state a confidence tier; refused to buy or add to cart and pointed to the marketplace and `/trades`; answered the lowest Messi ask on Panini with the listing link; resolved "Stephen Curry" to Steph Curry (130 editions). It could NOT name his cheapest edition — fixed: `get_player_editions` takes `order: fmv_asc`. The four probe rows are in `support_conversations` under session ids `qa-audit-1119-*`.
- **Scheduled tasks:** first page only (daily X draft, monthly deep audit, context hygiene — last runs succeeded). The full list was read and corrected on 11-17; it was not re-read tonight (each page is three full prompts).
- **Dashboard artifacts:** not re-run; the weekly surface QA read 13/13 sources clean at 9:35 AM PT today.
- **Laptop:** tree at `ca49163` (its pull is current), no git lock files, `/sessions` 30 % used. Four overnight patches dated 10-25 → 11-09 were still in `cowork-push/queue`; all four had landed, so they were moved to `cowork-push/applied`.

**Shipped in this addendum:** `6efd74e` (stored board, analytics tile, QA readme), `ff383f0` (cron_heavy refresher, light-theme fixes, concierge order, sweep env).

**Verified live after `ff383f0` (~11:03 PM PT):** the light sweep reads 0 flags on `/profile/absolutsiikness`, `/profile/jamesdillonbond`, `/analytics/loans` and a 404; the concierge answered "What is Steph Curry's cheapest moment on Top Shot?" with the S3 Base Common at $0.35 FMV and the next four; CI, Smoke Tests and E2E DOM Smoke green on `ff383f0`.

**Watch:** `select ok, duration_ms from pipeline_runs where pipeline = 'panini-market-board' order by started_at desc limit 6` — all ok, under 600 s. A Vercel log line "panini stored board err, reading live" means the copy went unreadable. One ok=false row at 10:07 PM PT 11-19 is this session's own verification query.


## Addendum 2 — 1:27 AM PT 11-20 follow-up check (read-only, nothing shipped)

Clock read from `TZ=America/Los_Angeles date` and the DB (both 1:27 AM PT).

- **Candy ghost-purge (`rpc-candy-wmc-ghost-purge`)**: the 1:10 AM PT run succeeded in **33.4 s** (11-19: killed at 120.1 s; 11-18: 76.4 s). Just outside the 15–30 s estimate, well inside the 60 s line — the prefilter from `20261119110000` holds.
- **Panini Market board**: the live-view board read (pgss queryid `-2469837307554637919`) is still at **5,595 calls** — zero since the 9:40 PM PT baseline, so no request has fallen back to the live view. Hourly refresher (jobid 898, `cron_heavy`): 11:37 PM 14.5 s, 12:37 AM 20.5 s, both ok; stored copy 50 min old at read time. API probe (`/api/market?collectionId=panini-blockchain`): `price_asc` 200 MISS 5.1 s then HIT 0.44 s; `fmv_desc` 200 MISS 1.05 s then HIT 0.43 s; 50 rows each. The 5.1 s cold read is slower than the 46 ms board read implies — the rest is the route's other work on a cold function, not measured further here.
- **CI / deploy**: CI green on `aca0ef7` (the nightly pass's docs commit); E2E DOM Smoke, Site Availability Alarm and Ops Monitor green on `b3a6481`. The three newest production deployments read CANCELED — all docs-only commits, skipped by `ignoreCommand`, as expected.
- **Trust board**: 41 / 42 ok. One breach, unchanged: `candy_revival_sales_since_recorded_silence` 429.83 vs 250. The nightly pass (`aca0ef7`) queued the Candy status-row re-verify rather than changing it. Stalled pipelines: none. Security invariants: empty.
- **Vercel runtime errors, last 4 h**: 5 groups, 7 events, none new and none on tonight's code: `/api/analytics/sales/leaderboard` 57014 ×3, `refresh-insights-cache` (`panini_deal_board_all` timeout + its 60 s task timeout) ×1 each, franchise-hub `get_team_activity` timeout degrading to empty ×1, one Panini edition market-cap tile over 8 s ×1. The leaderboard timeout is the only repeater and is worth a look in a daytime pass.
- `scripts/qa/README.md` Chromium path: already fixed earlier tonight.
