# Handoff — 2026-11-10 autonomous afternoon pass (Claude Code cloud)

Trevor: "Can you work autonomously for the next 10 hours? … Fix any issues you encounter." Started ~11:50 AM PT.
This file is written as the pass goes (draft at 1:55 PM PT, updated 3:00 PM PT); the ledger has every entry with its revert path.

## Shipped (all on `main`, all in the ledger, newest first)

| PT | What | Measured effect |
|---|---|---|
| ~2:55 PM | **Sentinel trust arms (WARN 2:04 PM PT)** — see the section below | 2 staged for Cowork, 2 explained |
| ~2:45 PM | Candy sales indexers price past-day sales from `public.sol_usd_daily` before CoinGecko (`primeSolUsdFromTable`; table staged for Cowork) | Fails soft until applied; then 2,528 `no_sol_rate` sales (667.7 SOL) drain ~300/run |
| ~2:27 PM | Panini sale-feed status refresh hourly; view window 75 → 135 min (`20261110222110`) | Half of a 5.2M-row index scan every 30 min (22–30 s/run) |
| ~2:30 PM | #246 progress read: 109,757 cards left on name-only editions, ~7k/h, integrity flags 9,581 (breach 250; corrected — "6" was the view's row count) | docs |
| ~2:20 PM | `get_user_top_owned_moments` estimates only the returned page (`20261110221809`, pinned) | Whale default first load 2.3 s → 0.9 s warm; 240-row parity across 6 shapes |
| ~2:12 PM | #243 closed (exit met: cold 6k-card Panini search 4.4 s); inbox 1715Z + 1800Z marked resolved | docs |
| ~1:55 PM | `detect_new_edition_early_buyers` fences its first-sale CTE (`20261110215349`, pinned: pin + registry re-pointed) | All Day > 55 s → 0.19 s; was pushing `run_all_insider_detectors('nfl_all_day')` past the ~120 s gateway cap on 5 of 48 runs |
| ~1:50 PM | `count_insider_detector_candidates` early-buyer branch reads the recent window (`20261110214948`) | All Day > 55 s → 3 s; its telemetry read "failed" on 4 of 5 sampled runs. Top Shot old = new = 11 |
| ~1:50 PM | Cron routes self-call `CANONICAL_ORIGIN`; guard bans a request-derived origin (`lib/canonical-origin.ts`, tree-walk test) | `golazos-discover-buyers` had the latent 401 shape |
| ~1:45 PM | **#245 resume dispatches to `www`** — it was POSTing back to the SSO-protected deployment URL Vercel Cron arrives on | Every resume was a Vercel 401; 1:53 PM run: picked 3, dispatched 3, queue empty, 3 walks started |
| ~1:40 PM | `fmv_recalc_historical_candidates` probes sales per edition (`20261110213841`) | 60 s timeouts on 7 of 75 fmv-recalc runs → 2.7 s |
| ~1:35 PM | Live-ask resolver reads Panini asks via keyed RPC `panini_confirmed_low_asks` (`20261110213132`) | 12 s/call → 17 ms in production; 1,990-key EXCEPT both ways = 0 |
| ~1:25 PM | Generic-plan-safe null-buyer indexes on `sales_2023/24/26/27` (`20261110212505`) | Buyer-backfill count probe ~176k blocks → 102 |
| ~1:15 PM | `backfill_wmc_fmv_confidence` LIMIT after the priced join (`20261110211850`, pinned) | Top Shot labellable backlog 1,090 → 400 → draining |
| ~1:05 PM | `populate_wmc_image` LIMIT after the edition join | 6,252 stuck Candy images filled |
| ~1:00 PM | `mv_panini_squeeze` aggregates only its own editions | refresh 148 s → 0.56 s |
| ~12:50 PM | `resync_stuck_wmc_fmv` skips collections with no wallet rows | Panini 440k buffers/h → 0 |
| ~12:45 PM | Candy forced wmc resync every 2 h | ~170 s/h for ~0 rows |
| ~12:40 PM | Pinnacle opener + Top Shot pull-chain pg_cron slots sleep only when there is work | ~30 worker-hours/day |
| ~12:35 PM | Edition page bundle: two indexes (freshness gate, sub-edition siblings) | freshness gate 2,991 → 4 buffers |
| ~12:30 PM | Sniper deal reads hash-join the listed pool | 94k → 12k buffers |
| ~12:25 PM | Pack summary/history read budgets 8 s → 20 s | under maxDuration 30, below the 30 s DB ceiling |
| ~12:10 PM | Panini Sets tab reads one product (`panini_set_progress_for_product`) + covering owner index | 141k-card holder: 84 s → 200 OK |

## Queued for Trevor / Claude Code

- **DROP `mv_panini_squeeze_retired_20261110`** — no dependents, no refresher; kept one day as the revert path.
- ⚠ **Do NOT drop `idx_panini_serials_owner_lower_incl` on the frozen-counter premise — it did not stay frozen:** 7:05 PM PT read 260,820 (+45 since noon, last scan 6:38 PM PT), while the new `_cover` (472 MB, superset INCLUDE) has 6 scans, last 12:12 PM. The planner still prefers the smaller `_incl` for a frequent per-owner read (the 10-15 rotation-targets shape). Dropping it saves 345 MB but sends those reads to a 1.37× larger index — a trade-off to decide, not a cleanup.
- **#247 Candy census re-key** (census owner): 1,697 keys / 133,366 cards / 8,097 wallets split across four key schemes for one card family.
- **Confidence-only changes in `refresh_wmc_fmv_changed`** (pinned 10-min lane): drops editions whose price did not move, so a confidence change waits ≥ 6 h for the hourly backstop (1:33 PM run fixed 17,864 rows). Options: carry confidence in the fast lane, or an incremental backstop window + a daily full sweep. Internal field, so low user impact.
- **`populate_wmc_fmv_from_snapshots` NULL-only path** takes `LIMIT p_limit` before the priced join (same class as the image/confidence fixes). Nothing is stuck today (0 priceable NULL rows in any collection), and the obvious rewrite would probe all 1.33M unpriceable Candy rows per call — revisit when Candy editions start getting `fmv_snapshots`.
- ✅ #245 closed 2:25 PM PT (resume proven end to end).
- ✅ #242 closed 7:10 PM PT (25/25 :53 runs ok in its 24 h window, max 23 s).
- **Watch `/api/profile/top-moments`** after `20261110221809`: the first call after the replace read 23.7 s cold for the 47k-row account (1.1 s right after). A real budget miss in Vercel logs is the signal to look at the cold path (wallet leg `editions` probes, 190k buffers).
- ✅ **2:05 → 4:05 PM pgss window read (4:50 PM PT):** the buyer-backfill counts were NOT fixed by the 1:25 PM indexes — through PostgREST they still seq-scan `sales_2023..2025` (176k blocks / 14 s; 73k / 5–9 s) although every SQL replica uses the indexes at ~100 buffers. Routed around: `topshot_buyer_backfill_window_counts` (`20261111004919`) + route `readWindowCounts()` (`d63724eea`). Verify at 5:40 PM PT. **Open question for a later session:** why PostgREST's plan differs from `EXPLAIN (GENERIC_PLAN)` on the same text — the same shape may be costing other `head:true` counts on partitioned `sales`.

## Sentinel trust arms (WARN 11-10 2:04 PM PT)

| Arm | Reading | Cause | State |
|---|---|---|---|
| `candy_sales_stale_hours` (breach 0) | 24.7 | 2,528 Candy sales parked `no_sol_rate`: CoinGecko SOL/USD history fails from Vercel egress, works from pg_net | App half live; `sol_usd_daily` table + 6-hourly pg_net tick **staged for Cowork** (`docs/handoff-2026-11-10d-…` part A) — `apply_migration` approval prompt timed out twice |
| `candy_revival_sales_since_recorded_silence` (breach 1) | 1 | One $0.17 ME sale 11-09 (+4 dust sales parked): a trickle | View re-date to `silent_since_2026_11_10` **staged for Cowork** (part B), tested on scratch PG |
| `candy_ask_book_drop_pct` (breach 60) | 91.2 | False positive: 208 ghost ME asks ingested + deactivated in the 11-09 7:35 PM PT pass sit in the "seen 24 h" denominator; real book is 20 | Clears ~7:35 PM PT 11-10 by itself; optional arm fix: drop `owner_moved_at` rows from the denominator |
| `edition_integrity_flags` (breach 250) | 9,581 | 9,559 Candy name-only editions (#246); census repoints ~7k cards/h, ~110k left | Drains on its own (~16 h); do NOT raise the threshold or exclude Candy. Remainder: 8 TS thumbnails, 14 UFC tiers |

## 3:30 PM PT sweep

- **Vercel runtime errors since 12:15 PM PT: none.**
- **`pg_net_http_401` (critical) is self-inflicted:** the 2:29 PM PT CoinGecko probe from this session used 2025 epoch timestamps ("exceeds the allowed time range"). Not an edge-function fault; ages out of the 2 h window ~4:29 PM PT. `sol_usd_daily` (applied by Cowork, `20261110230100`) asks for 100 days, inside the limit — its fill answered 200.
- **`pinnacle-catalog-backfill` failure_rate (medium) pools across a recovery:** 1:37 PM PT run reads 0 missing renders (was 29 on 11-09).
- **`candy-collections-census` failure_rate (medium):** Candy metadata host 429s during the #246 re-hydration; the census still repoints ~7k cards/h. Known.
- **`refresh_wmc_fmv_changed`:** one statement timeout at 3:08 PM PT in ~150 runs over 12 h (avg 3–7 s, max 30 s). Watch at 7:05 PM PT; not acted on.
- **Pipeline failures otherwise:** wallet-backfill 508 continuation (recovered by the #245 resume), Atlas/Candy upstream 403/429/timeouts, one Panini walk for a wallet whose username Panini no longer has — all known classes.
- **Inbox:** 1607Z (chain-arrivals seed) and 0645Z (Candy revival) marked resolved; 1840Z's UFC fix was already applied (`20261110184532`), its seven-reader item stays a recorded choice.
- **Candy trust arms:** revival 1 → 0 (`20261110225146`); `sol_usd_daily` live (Cowork) — 2,528 parked sales all fall on covered days; the 4:20 PM PT indexer run is the first to price them (check-in 4:26 PM PT).

## 4:26 PM PT — Candy SOL/USD fix proven in production

4:20 PM PT `candy-sales-indexer`: `sol_days_primed_db` 100, `sol_db_error` null, `drain_resolved` **297 of 300**, `rows_written` 297, `unresolved_open` 2,578 → **2,278** (previous runs: 0 resolved, every 3 h). At 300 a run the backlog clears in ~8 runs (~1 day); `candy_sales_stale_hours` leaves breach once < 50 sales parked in 48 h remain. CI on the code commit (`cfbc1f573`, run 9775) green.

## Evening (5:40 – 6:35 PM PT)

- ✅ Buyer-backfill counts fix verified: 5:34 PM run 8.7 s (was ~20 s), values unchanged, no seq scan of `sales_2023..2025` since 4:34 PM.
- ✅ `fmv_backfill_candidates` prefilters on `edition_fmv_current`, timeout 90 s (`20261111014609`, pinned): 705k → 533k buffers, 13.4 s → 4.2 s. **Watch** the next `fmv-backfill` runs for `ok`.
- ✅ `sales_2026` / `sales_2027` `ingested_at` index (`20261111023056`): the Sentinel's 2 h ingest count 52k blocks / 3.5 s → 62 / 26 ms.
- **Queued — `pack_table_rows` (the /api/packs board view):** ~90k buffers / 1.4 s per call (page + exact count, ~13 calls/h). One cause found: its `pack_ask_state` LATERAL's OR leg `(collection_slug = 'laliga-golazos')` carries no `dist_id`, so every board row bitmap-reads the Golazos ask slice (24k of 58k buffers on a Top Shot page). Fixing it is a `CREATE OR REPLACE VIEW` of a 14k-char view with dependents (re-specify `security_invoker`); ~100 ms/page — left for a fresh session.
- **Open question still:** why PostgREST's plan for the buyer-backfill counts differed from every SQL replica.
- **Small, queued:** `lib/insights/panini-more-boards.ts` counts `panini_special_serials_board` twice per hourly render (total + listed); each count pays the view's per-edition newest-FMV LATERAL that a count never reads (30k buffers / 1.3 s for 13,370 rows; ~1.8M blocks/day). Fix = count the base table with the view's own predicates, or a count function next to the view.
- **Context, not a defect:** `resync_stuck_wmc_fmv` runs 2–5 min hourly and fixes 1.5k–23k rows each time — the cost of the "confidence-only changes miss the fast lane" item above; closing that item is what shrinks it.
