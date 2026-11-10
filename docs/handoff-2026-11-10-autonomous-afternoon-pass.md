# Handoff — 2026-11-10 autonomous afternoon pass (Claude Code cloud)

Trevor: "Can you work autonomously for the next 10 hours? … Fix any issues you encounter." Started ~11:50 AM PT.
This file is written as the pass goes (draft at 1:55 PM PT, updated 2:35 PM PT); the ledger has every entry with its revert path.

## Shipped (all on `main`, all in the ledger, newest first)

| PT | What | Measured effect |
|---|---|---|
| ~2:27 PM | Panini sale-feed status refresh hourly; view window 75 → 135 min (`20261110222110`) | Half of a 5.2M-row index scan every 30 min (22–30 s/run) |
| ~2:30 PM | #246 progress read: 109,757 cards left on name-only editions, ~7k/h, integrity flags 6 (under 250) | docs |
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
- **DROP `idx_panini_serials_owner_lower_incl`** (344 MB) once its `idx_scan` stays at 260,777 (frozen since 12:02 PM PT 11-10); the 7:05 PM check-in reads it.
- **#247 Candy census re-key** (census owner): 1,697 keys / 133,366 cards / 8,097 wallets split across four key schemes for one card family.
- **Confidence-only changes in `refresh_wmc_fmv_changed`** (pinned 10-min lane): drops editions whose price did not move, so a confidence change waits ≥ 6 h for the hourly backstop (1:33 PM run fixed 17,864 rows). Options: carry confidence in the fast lane, or an incremental backstop window + a daily full sweep. Internal field, so low user impact.
- **`populate_wmc_fmv_from_snapshots` NULL-only path** takes `LIMIT p_limit` before the priced join (same class as the image/confidence fixes). Nothing is stuck today (0 priceable NULL rows in any collection), and the obvious rewrite would probe all 1.33M unpriceable Candy rows per call — revisit when Candy editions start getting `fmv_snapshots`.
- **#245 close-out** — read the three resumed walks (0x32c6…, 0xc246…, 0x75b5…) to completion, then close the item and regenerate the status index with `docs:issues-index` (diff before `git add`).
- **Watch `/api/profile/top-moments`** after `20261110221809`: the first call after the replace read 23.7 s cold for the 47k-row account (1.1 s right after). A real budget miss in Vercel logs is the signal to look at the cold path (wallet leg `editions` probes, 190k buffers).
- **Read the 2:05 → 4:05 PM pgss window**: one buyer-backfill `sales` count (HIST window, payer NOT NULL) read 51,756 blocks at ~2:10 PM although the same statement under a generic plan is 102 buffers — confirm per-call cost there is now ~100.
