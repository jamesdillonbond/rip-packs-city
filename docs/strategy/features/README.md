# Feature roadmaps — index (refreshed 2026-10-17, PT)
> Each file below covers one feature area across every collection. They are dated snapshots, so re-derive any number before quoting it. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

**Binding rules** (all six files):
- read-only product: no cart, trade or gifting;
- **accuracy is the GATE**;
- no paid tier until 100 WAU;
- no infra spend before revenue;
- no outreach until the gate passes.

| file | status (10-17) |
|---|---|
| [fmv-pricing.md](fmv-pricing.md) | 🔴 **Neither bar met on the share, M1 by decision (10-22 read: wk 10-19 Top Shot 44.5 — the 1.8.2 label correction landed exactly as priced; All Day 27.3). Accuracy half unchanged (TS HIGH 10.0 % MdAPE / 81.4 % within ±25 %). All Day ASK_ONLY capped at recent sales 10-22 (#208).** ⓘ 10-17 line follows — Top Shot 55.2 % HIGH/MED (bar 50). All Day 26.4 % (bar 30), with 0 legs at the bar since 09-28. Model 1.8.1. R125 closed 10-17: published FMV matches or beats a naive last-3 median. The sweep-wedge fix (10-17) is still to be verified. |
| [pack-ev.md](pack-ev.md) | 🟢 **Live Atlas pools** and EV on 777 Top Shot dists (#65). Boxes priced (#187/#188). Pack Reality's fabricated 11 % fixed. 🔜 Series 9 pack check owed 10-20. Pre-2023 opens declined (#190). |
| [sniper-and-deals.md](sniper-and-deals.md) | 🟡 Outbound "View Listing" only. The Flowty API is still alive (72/72 runs per lane, 10-17). No priced column depends on it: All Day and Golazos asks come from Dapper storefronts, Top Shot's from Atlas, so only the teardown remains. Candy sales silent since 10-11. |
| [wallet-and-portfolio.md](wallet-and-portfolio.md) | 🟢 Ownership index at 528,568 rows, walk-confirmed and Series-9 ready. The share card is the one proven acquisition path, but sign-in clicks are 10 → 0. Achievements NOT widened (10-17). |
| [insights-and-seo.md](insights-and-seo.md) | 🟡 ~32 public boards with honest empty states. Sitemap at 9 children. #66 open: external links held by the gate. 🔜 Demand re-read 10-22 (night pass owns it: focus.md steer). Search Console re-read 10-28. |
| [concierge-and-alerts.md](concierge-and-alerts.md) | 🟡 Concierge correct but barely opened (R73, watch to ~10-28). Alerts are what users use: once per listing, on the transition. Digests flag-off, blocked on the C2 postal address (Trevor). |

**Owed by a clock (refreshed 10-22 ~11 PM PT):**
- ✅ 10-20 Series 2026-27 ingest check (done; first mint 10-21, Rookie Debut early) · ✅ 10-22 demand re-read (done, `scripts/demand-read.sql`; next on/after 10-29).
- **10-24:** #181 retire/keep pre-mainnet27 lookups (still dark 10-22; 1,241 floor probes) · Pinnacle #193 gate lands (HIGH n 467 of 500 on 10-22) · Panini 1.4.0 window opens.
- **10-26 ~7:23 AM PT:** the weekly missing-fill walk re-seeds its cursor — `check_backward_cursor_rewind()` must stay `[]` (direction-by-majority fix, 10-22).
- **~10-28:** R73 concierge watch · Search Console re-read (now incl. the `/players/` and `/teams/nba/` hub families the sitemap lists since 10-23) · #202 `panini_fmv_ask_cap_shadow_backtest(7)`.
- **~10-30, then weekly:** #208 — `fmv_sales_backtest('nfl_all_day', 7)` ASK_ONLY row near ratio 1.0, within ±25 % ≥ 30 %.
- **On or after 11-11:** rookie class rebuilt from Series 9.
