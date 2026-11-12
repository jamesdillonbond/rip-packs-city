# Handoff — 2026-11-10 autonomous afternoon pass (Claude Code cloud)

Trevor: "Can you work autonomously for the next 10 hours? … Fix any issues you encounter." Started ~11:50 AM PT.
This file is written as the pass goes (draft 1:55 PM PT; CLOSED 9:35 PM PT); the ledger has every entry with its revert path.

## Shipped (all on `main`, all in the ledger, newest first)

| PT | What | Measured effect |
|---|---|---|
| ~7:55 PM | Linked Panini walk skips a `not_found` username for 24 h (`20261111034703`) | `mempheattle` stops failing every 2 h run |
| ~7:50 PM | `pack_table_rows` live-ask lookup is one key (`20261111032656`) | /api/packs Top Shot page 58k → 28k buffers; live asks reconcile 2,031/951/1 |
| ~6:30 PM | `sales_2026`/`2027` `ingested_at` index (`20261111023056`) | Sentinel 2 h ingest count 52k blocks / 3.5 s → 62 / 26 ms |
| ~6:15 PM | `fmv_backfill_candidates` prefilter + 90 s timeout (`20261111014609`, pinned) | 705k → 533k buffers; cold 11.6 s vs the 60 s it died at |
| ~5:05 PM | Top Shot buyer-backfill counts through `topshot_buyer_backfill_window_counts` (`20261111004919`) | forward run ~20 s → 8.7 s; no more seq scans of `sales_2023..2025` |
| ~2:55 PM | Candy marketplace silence re-dated (`20261110225146`); `sol_usd_daily` applied by Cowork (`20261110230100`) | revival arm 1 → 0; 581 parked Candy sales priced by 7:20 PM PT |
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

1. ✅ **RESOLVED 11-11 ~1:20 PM PT:** `fmv-backfill` ok on both real runs since the change (11:11 PM PT 5.9 s, 7:28 AM PT 0.6 s). Was: **[P2, Claude Code, 0 nights] Confirm `fmv-backfill` on its next real run.** The 60 → 90 s change (`20261111014609`) is proven only by a direct call (11.6 s cold); no external run has happened since 4:35 PM PT. Close the 0112Z filing's item 1 when a run reads `ok=true`.
2. **[P2, census owner (Claude Code/Cowork), 1 night] #246 integrity arm went UP, as expected: 8,159 → 11,548.** The census created 4,126 Candy editions 9:00–9:06 PM PT (real `c:<collection>:<card>` keys, e.g. 2025 MLB Gems, 2022 Football Icons), 4,079 without a tier; orphan cleaners are deleting the old name-only rows (500/run cap hit at 9:22 PM PT). Watch that tier/circulation hydration catches up; a rise that does not fall back within a day is a hydration gap, not churn.
3. **[P3, Claude Code, 0 nights] #247 Candy census re-key** (census owner): 1,697 keys / 133,366 cards / 8,097 wallets split across four key schemes for one card family.
4. **[P2 ↑ (re-ranked 11-11 ~10:40 PM PT), Claude Code (daytime), 1 night] The hourly backstop `resync_stuck_wmc_fmv` is one of the estate's largest disk readers: 24 h pgss (11-10 10:05 PM → 11-11 10:40 PM PT) = 25 calls, 42.0M buffers, 7.34M disk reads, 3,797 s (~63 min of DB time a day) — 5× the 10-min lane it backs up (`refresh_wmc_fmv_changed` 148 calls, 8.6M buffers, 571k reads, 398 s) — while only ~3 % of wmc rows are mismatched at any moment (sample below). Two levers, measure before/after on THESE numbers: (a) make the backstop incremental (editions whose `edition_fmv_current` row or wmc rows changed since its last run) or less frequent; (b) carry confidence in the fast lane (below) so the backstop has less to fix. Both change how fast a user's portfolio value is corrected — decide with Trevor-visible numbers, not at night.** Original item: Confidence-only changes in `refresh_wmc_fmv_changed` — 📏 measured 9:50 PM PT on a 2 % `tablesample` of Top Shot + All Day wmc: **1.6 % of rows differ from `edition_fmv_current` in confidence ONLY** (TS 554 / 34,261; AD 208 / 11,301) vs 1.3 % in price (in flight for the 10-min lane). The fast lane writes `fmv_usd` only and its unchanged-price DELETE drops a confidence-only change, so the hourly backstop carries ~half its load for an internal field. Design: keep an edition in `_rwfc_recent` when price OR confidence moved, and set `fmv_confidence` in the UPDATE (same vocabulary the backstop writes, from `edition_fmv_current`); re-pin `refresh_wmc_fmv_changed`. Deferred out of a night slot (pinned 10-min lane). (pinned 10-min lane): an edition whose price did not move waits ≥ 1 h for the hourly backstop, which is why `resync_stuck_wmc_fmv` runs 2–5 min and fixes 1.5k–23k rows every hour. Options: carry confidence in the fast lane, or an incremental backstop window + a daily full sweep.
5. ✅ **DECIDED 9:50 PM PT (Claude Code, Trevor: "Do what you think is best"): KEEP `idx_panini_serials_owner_lower_incl`.** Was: **[P3, Trevor decides, 0 nights] `idx_panini_serials_owner_lower_incl` (345 MB) is NOT idle** (260,820 scans, +45 since noon, last 6:38 PM PT) while the superset `_cover` (472 MB) has 6. Dropping `_incl` saves 345 MB but moves a frequent per-owner read onto a 1.37× larger index — a trade-off, not cleanup.
6. **[P3, Cowork, 1 night] → HANDED TO COWORK 11-11 ~10:40 PM PT (inbox `2026-11-12T0640Z`, runbook inside).** DROP `mv_panini_squeeze_retired_20261110` — checked safe 11-11 1:20 PM PT (0 dependents / cron / function refs, 2.8 MB) but the DROP raised Supabase's destructive-statement question, unanswered; run `DROP MATERIALIZED VIEW public.mv_panini_squeeze_retired_20261110;` in the SQL editor (or answer the prompt).** Was: — no dependents, no refresher; kept one day as the revert path (safe from 11-11 ~1 PM PT).
7. ✅ **PARTLY DONE 11-11 10:38–10:41 PM PT (REINDEX CONCURRENTLY, jobs 866/867): the two largest rebuilt — `idx_wmc_lock_wallet_coll_cover` 989 → 467 MB, `idx_wmc_wallet_coll_ek_fmv_tier` 871 → 406 MB; the other four wait for Saturday's weekly run.** Was: **[P3, Claude Code, 0 nights] wmc index bloat from the census:** six weekly-reindexed wmc indexes grew 3–4.5× since 11-07 while rows grew ~1.6× (e.g. `idx_wmc_lock_wallet_coll_cover` 937 MB, `idx_wmc_wallet_coll_ek_fmv_tier` 852 MB). The Saturday reindex resets it; consider a mid-week `REINDEX CONCURRENTLY` of the two largest if the census keeps this pace.
8. **[P3, Claude Code, 0 nights] #241 pg_net attribution:** one `AFTER INSERT` trigger on `net.http_request_queue` (postgres holds TRIGGER) could log every request URL for all lanes — must swallow its own errors, be checked for existence after a pg_net upgrade, and the 40k-char `check_edge_fn_http_failures` `grp` CTE must carry request ids. Details in the register.
9. **[P3, Claude Code, 0 nights] Open question — PostgREST plan vs SQL replicas:** the buyer-backfill `head:true` counts seq-scanned `sales_2023..2025` in production while every replica (custom, generic, untyped, `EXPLAIN (GENERIC_PLAN)` on the verbatim text, as service_role) used the indexes at ~100 buffers. Routed around with a function; other `head:true` counts on partitioned `sales` may carry the same cost.
10. **[P4, Claude Code, 0 nights] Panini special-serials board counts** (`lib/insights/panini-more-boards.ts`): two counts per hourly render pay the view's unused FMV LATERAL (30k buffers / 1.3 s each). Low value.
11. ✅ **RESOLVED by another session 11-11 (`20261111172832`: the NULL-only path locks only rows it will fill).** Was: **[P4, Claude Code, 0 nights] `populate_wmc_fmv_from_snapshots` NULL-only path** takes `LIMIT p_limit` before the priced join; nothing stuck today — revisit when Candy editions start getting snapshots.
12. **[P4, Claude Code, 0 nights] Optional: `candy_ask_book_drop_pct` denominator** could exclude rows deactivated in the same pass (`owner_moved_at`); the 11-09 ghost-ask false positive cleared on its own at 7:35 PM PT 11-10.

Closed this pass: #245 (2:25 PM PT), #243 (2:12 PM PT), #242 (7:10 PM PT). Watch: `/api/profile/top-moments` cold misses after `20261110221809`.

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
- ✅ **DONE 7:55 PM PT (`20261111032656`):** ~~Queued — `pack_table_rows` (the /api/packs board view):** ~90k buffers / 1.4 s per call (page + exact count, ~13 calls/h). One cause found: its `pack_ask_state` LATERAL's OR leg `(collection_slug = 'laliga-golazos')` carries no `dist_id`, so every board row bitmap-reads the Golazos ask slice (24k of 58k buffers on a Top Shot page). Fixing it is a `CREATE OR REPLACE VIEW` of a 14k-char view with dependents (re-specify `security_invoker`); ~100 ms/page — left for a fresh session.~~ Shipped after all: one-key probe, page 58k → 28k buffers, rows identical.
- **Open question still:** why PostgREST's plan for the buyer-backfill counts differed from every SQL replica.
- **Small, queued:** `lib/insights/panini-more-boards.ts` counts `panini_special_serials_board` twice per hourly render (total + listed); each count pays the view's per-edition newest-FMV LATERAL that a count never reads (30k buffers / 1.3 s for 13,370 rows; ~1.8M blocks/day). Fix = count the base table with the view's own predicates, or a count function next to the view.
- **Measured, no change — `close_sold_topshot_listings_and_floors` (`ts-sold-floor-clear`, 9×/h, ~24 s):** the floor leg is the cost (one `sales_2026` nft probe per held ask: 13,769 floors, 89k buffers / 7.1 s cold, ~6.5 buffers each); the recent / refill / verify legs are < 200 buffers. Driving it from sales instead needs every sale since the oldest `low_ask_confirmed_at` (09-16), and an incremental window changes the guarantee on a user-visible floor path. Left as is.
- **Context, not a defect:** `resync_stuck_wmc_fmv` runs 2–5 min hourly and fixes 1.5k–23k rows each time — the cost of the "confidence-only changes miss the fast lane" item above; closing that item is what shrinks it.

## 7:25 PM PT — Sentinel arm timeline (read, nothing to ship)

- `candy_ask_book_drop_pct` 90.8: confirmed the cause — all 208 inactive rows in its 24 h denominator were last seen in the 7 PM PT hour of 11-09 (21 active vs 229 seen). Clears when they age out (~7:35–8:00 PM PT 11-10).
- `candy_sales_stale_hours` (breach 0 via "> 50 unresolved first seen in 48 h"): 335 open in that window (274 `no_sol_rate`), first seen 11-08 9:48 PM → 11-09 5:51 AM PT. The SOL drain resolves ~290/run (7:20 PM: 284; open 2,578 → 2,278 → 1,979). The arm clears by **~5:51 AM PT 11-11** at the latest (age-out), earlier if the drain reaches them. No action.
- `edition_integrity_flags` 8,159 (from 9,581 at 2:30 PM PT): #246 census repair, ~1.4k/5 h. No action.

## 7:45 – 8:20 PM PT

- ✅ `candy_ask_book_drop_pct` cleared to 0.0 after the 7:35 PM PT listings run (21 active / 21 seen; the 208 ghost asks aged out and were not re-ingested).
- ✅ Linked Panini walk skips a `not_found` username for 24 h (`20261111034703`): `mempheattle` had been re-walked and logged ok=false on all 6 linked runs since 7:20 AM PT.
- ✅ `pack_table_rows` change verified by request: `/api/packs?collection=laliga-golazos` 200 (cache MISS, 223 packs); rows carrying a live ask = listed asks in `pack_ask_state` exactly — Top Shot 2,031/2,031, All Day 951/951, Golazos 1/1.
- Looked at, no change: `analytics_sales_summary` (7 s mean, but CDN-cached 10 min + 20 min SWR — ~6 refreshes/h); the wmc keyset page in the wallet walk (1.6k buffers / 700 ms, proportional to its 1,000-row page; a covering index on wmc is not worth its size); the THP trust legs (6-hourly, Panini 74 s).

## 8:15 – 8:45 PM PT

- `fmv_backfill_candidates` under the production role, cold: **11.6 s / 521k buffers, 0 rows** — inside the new 90 s (the 4:35 PM PT run died at 60 s). The next real `fmv-backfill` run still owes the `ok`.
- **wmc index bloat, watch only:** the six weekly-reindexed wmc indexes grew 3–4.5× since the 11-07 7:43 PM PT rebuild (e.g. `idx_wmc_wallet_coll_ek_fmv_tier` 190 → 852 MB, the unique key 150 → 460 MB) while rows grew ~1.6× (1.34M Candy rows from the #246 census since the rebuild; 163M updates on the table). Roughly half is census churn bloat. The weekly `REINDEX CONCURRENTLY` jobs (Sat ~6–8 PM PT) reset it; if the census keeps this pace, consider a mid-week reindex of the two largest (`idx_wmc_lock_wallet_coll_cover` 937 MB, `idx_wmc_wallet_coll_ek_fmv_tier` 852 MB).
- #228's index swap was already done (Cowork 11-04); register note added. #241 note: a single trigger on `net.http_request_queue` could log every pg_net URL — conditions recorded, not built.

## Closing sweep — 9:35 PM PT

- Runtime errors since 7:05 PM PT: 2 single hits, both long-standing groups — `get_set_activity` statement timeout on a set page (8:15 PM PT, degraded to empty as designed) and `/insights/squeeze` 8 s read (8:29 PM PT; first seen 08-16). Nothing on `/api/panini-set-progress`, `/api/wallet/pack-*`, `/api/packs`.
- Failing lanes (2.5 h): only upstream classes (Atlas 403s, one 20 s fetch timeout) plus the 7:41 PM PT `mempheattle` walk that the 7:55 PM PT change now skips.
- Alerts medium+: `wallet-backfill-continuation` HIGH (pooled 3-day rate over the #245 fix; last failure 2:11 PM PT, resume queue empty), `candy-collections-census` medium (metadata 429s), `fmv-backfill` medium (pooled over the fix; item 1).
- Trust breaches: `candy_sales_stale_hours` (clears by ~5:51 AM PT 11-11 by age-out; 10:20 PM PT drain run next) and `edition_integrity_flags` 11,548 (item 2). `candy_ask_book_drop_pct` and `candy_revival_sales_since_recorded_silence` are ok.
- Inbox: one open filing (0112Z) — item 1 acted on (pending item 1 above), item 2 left for the night pass.

## 9:50 PM PT — decisions after "Do what you think is best"

- Kept `idx_panini_serials_owner_lower_incl` (item 5): it serves a live, frequent read; the 345 MB saving would move that read onto a 1.37× larger index.
- Item 4 measured and designed, deliberately not shipped at night: a pinned lane running every 10 min, for an internal-only field.
- Item 6 (DROP `mv_panini_squeeze_retired_20261110`) waits for its one-day revert window (from ~1 PM PT 11-11).

## 11-11 ~1:20 PM PT — scheduled follow-up

- ✅ Item 1: `fmv-backfill` ok ×2 since the change. ✅ `candy_sales_stale_hours` cleared (4.2 h). ✅ `edition_integrity_flags` 11,548 → 7,537 (census hydrating the new Candy editions).
- 🔁 Revival arm tripped again (one $16.62 DC comic sale, 11-11 9:05 AM PT) → re-dated to 11-11 (`20261111211740`), arm 0.
- 13. ✅ **DONE 11-11 ~9:20 PM PT (`20261112063348`): breach_at 1 → 10.** Was: **[P3, Claude Code (daytime), 0 nights] Revival arm should need a floor, not one sale.** Six stray Candy sales (~$20) in four weeks have now forced two re-dates; each sale re-arms it. Count a revival only above a floor (e.g. ≥ 10 sales or ≥ $100 in 7 days, both measured from the pre-lock baseline of 86–374/day) — a change to the `candy_revival_sales_since_recorded_silence` arm in `v_rpc_trust_health` (55k chars; use the md5-guarded fragment method).

## 11-11 ~9:10 PM PT — evening sweep (nothing shipped)

- Runtime errors since 1:20 PM PT: 4 single hits, all read budgets — `/insights/parallel-premiums` (4:34 PM PT), `/insights/squeeze` (3:35 PM PT), and at **8:15 PM PT** `/teams/nba/oklahoma-city-thunder` panel (10 s) + `/insights/allday-squeeze` (8 s). The 8:15 PM pair sat inside an overlap of three heavy lanes (topshot-active-listings-ingest 7.4 min from 8:13, candy-editions-ingest 5.0 min from 8:10, topshot-circulation-onchain 4.3 min from 8:05) — the estate-concurrency class, not a new defect. If it recurs at the same minute, stagger those three.
- `ts-sold-floor-clear` deadlock at 7:25 PM PT: 1 of 688 runs in 7 days; the next tick retries. No action.
- Trust: only `edition_integrity_flags` 6,793 (falling: 11,548 → 7,537 → 6,793). Alerts: `wallet-backfill-continuation` high and `fmv-backfill` medium are both 3-day pools straddling their fixes.
- Items 4 (confidence fast lane) and 13 (revival-arm floor) stay for a daytime session; item 6 (DROP the retired squeeze MV) still needs the Supabase prompt answered or the SQL editor.

## 11-11 ~10:45 PM PT — final state before the thread is archived

Trevor: "Hand that to cowork. Keep going and work through anything still unresolved from this thread. Then update any relevant documentation before I archive this thread."

- **Handed to Cowork:** item 6 (DROP `mv_panini_squeeze_retired_20261110`) — inbox `2026-11-12T0640Z` with pre-check, apply, record, post-check and repo half.
- **Done this round:** item 7 (two largest wmc indexes rebuilt, ~987 MB freed); item 11 found already resolved (`20261111172832`); item 13 earlier tonight (revival arm floor 10, `20261112063348`); inbox 2245Z and 0112Z marked resolved.
- **Re-ranked and registered:** item 4 → **#248** (P2) — the hourly backstop `resync_stuck_wmc_fmv` costs 7.34M disk reads / ~63 min of DB time a day for a ~3 % drift; levers and exit in the register. Needs a measured before/after and a decision on correction latency — not an unattended change.
- **Corrected:** the 11-10 claim that REVOKE / `cron.schedule` triggered Supabase's approval prompt was wrong — it was the `DELETE` inside `sol_usd_daily_tick()` (tooling-gotchas.md, the "holds SQL containing DELETE" section).
- **Still open, owned elsewhere or deliberately deferred:** #246 / #247 (census owner; integrity flags falling 11,548 → 6,793); item 8 = #241 (estate-wide pg_net trigger — needs a daytime build with a trigger-exists check); item 9 (the PostgREST-plan question — lesson in database.md); item 10 (Panini special-serials counts, low value); item 12 (optional ask-book denominator tweak).
- **Nothing in flight:** 0 `zz-` cron jobs, 0 leftover `_ccnew`/`_ccold` indexes, every applied migration has its file on `main`.
