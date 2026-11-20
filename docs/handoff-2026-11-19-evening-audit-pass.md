# Handoff — 2026-11-19 evening audit pass (Cowork cloud)

> ⚠ Any limitation noted here is specific to **this cloud session**. Trevor's machine and Claude Code push normally. Commit these files as usual.

Trevor, 9:26 PM PT: "deep dive audit, full QA, SEO and marketing analysis, cybersecurity audit, health check of the database and pipelines … Fix any issues you encounter … Plan on working autonomously for 6 hours." Push worked through `add_repo`; DB, Vercel, Resend and Trevor's Chrome were reachable; no laptop folder was attached, so nothing ran on the laptop.

## Verdict

Platform GREEN · 1 shipped (`ca49163`) · idle elsewhere: no-work found that was safe and not already done by the 11-19 Claude Code thread · oldest routed: #261 acquisition dates, 4 nights (blocked on Dune until 12-14; the Atlas staging lane is filling it, ETA ~11-21).

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
