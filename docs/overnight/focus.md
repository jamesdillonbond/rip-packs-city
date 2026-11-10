# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-11-09 8:36 PM PT (Claude Code, Trevor's laptop) — five dated reads for the 11-10 overnight pass (this thread is being archived)

- **2:31 AM PT `wmc-metadata-selfheal` and 4:47 AM PT `topshot-map-atlas-reconcile` (pg_cron 818):** both failed once on 11-09 (120 s statement timeout during the census write storm); fixes applied 5:00 PM PT 11-09 (selfheal skips Candy + fill-only; 818 at 300 s). Read each lane's 11-10 row: `ok=true` closes the Sentinel's Pipeline Success Coverage warn. A repeat timeout → read `pipeline_runs.error` before touching it.
- **10:28 PM PT 11-09 trophies liveness probe (`public_board_liveness_history`, `v_insights_trophies`, max_ms 7,000):** already 7,587 ms at 4:28 PM PT, BEFORE the 1-of-1 guard. A partly-cold read at 8:30 PM PT took **9.8 s**: latest-FMV lateral 5,031 reads / ~6.4 s (pre-existing), held-card probe (`20261110034117`) 1,987 / ~2.3 s, editions scan ~1.4 s. The view now carries the MLB-only filter (`20261110041400`, another session). If the probe breaches, the lever is the FMV lateral, not the threshold — and re-baseline `max_ms` only after the Candy population settles (filing 2026-11-10T0318Z item 3).
- **Candy census (`candy-collections-census`):** the 429 back-off (`5afb9e8b6`) shows as `hydrate_rate_limit_retries`; 3 clean runs after it (repoints 5.4k / 9.2k / 11.5k). Only act if `HTTP 429` > ~10 % of `hydrate_fetches` again — then the lever is concurrency 48 → 32, not more retries.
- **#245 wallet-backfill continuation:** any `wallet-backfill-continuation` row (ok=false) names a broken chain's status/error — read it and update #245. None yet since the 6:40 PM PT deploy.
- **#243 trophy picker:** a cold Panini search for a big profile was not directly measured after `20261110025023` (warm 165 ms; ~2 s estimated cold). A `top-moments` read-budget miss in runtime errors reopens it.

## STEER — added 2026-11-04 10:40 PM PT (Cowork cloud) — three dated reads from the 11-04 evening pass + one unapplied migration

- ✅ **DONE — `20261105050000_audit_20261104_allday_low_haircut_075` applied 11-04 10:26 PM PT (recorded `20261105062649`; ledger `34151ff`).** Read back 10:45 PM PT: the version row exists and both haircut writers carry the All Day LOW arm. (A parallel Cowork session's attempt at ~10:30 PM PT was refused by its auto-mode classifier — moot.) Post-check from the handoff still applies after the next All Day fmv-recalc tick: new LOW `_haircut` rows with 0 sales in 30 d sit at 0.75 × floor.
- **All Day price ratio — re-read after 11-07.** `fmv_sales_backtest('nfl_all_day',7)` published median ratio read 0.900 on 11-04 because sub-$1 sales stepped from $0.16–0.17 to $0.22 (11-03) / $0.25 (11-04); 30 d read 1.000. Act only if the 7-d ratio is still < 0.90 once that step is inside the comps window (ledger 11-04 "real market move").
- **`net._http_response` — weekly read (next ~11-11).** 11-04: 3,033 MB file, 855 MB live bodies (504 MB on 11-02), 77 % Atlas market-feed pages; oldest row = 6 h TTL. High-water mark, not a leak. If still climbing, the lever is `atlas_market_drain` deleting consumed 200 responses AND re-pointing the 403-attribution arm (which joins those rows) — Trevor's call. Detail: inbox `2026-11-03T0705Z` (end).
- **Zero-yield noise:** `check_zero_yield_lanes()` lists the three Flowty `*-listing-cache` lanes (retired 10-30) until ~11-06, when their last runs leave its 7-day window. Not a finding.

## STEER — added 2026-11-04 5:27 PM PT (Claude Code cloud) — HANDED TO COWORK: run the staged #232 class-3 delete (754 more fake Top Shot sales)

- ✅ **DONE 11-04 ~5:45 PM PT (Cowork, dashboard SQL editor in Trevor's Chrome): 754 → 0, recorded `20261105014004_audit_20261104_atlas_backfill_seller_relisted_sales_delete`, staged file deleted.** Was: **Run `docs/proposals/atlas-backfill-seller-relisted-sales-delete-STAGED.sql` as ONE batch**, the same way `20261105010616` ran (dashboard SQL editor in Trevor's Chrome; the claude.ai connector's destructive confirmation timed out again at ~5:24 PM PT, unanswered). It is one DO block; it RAISEs and rolls back unless exactly 754 rows go. Backup `audit_20261104_atlas_backfill_seller_relisted_sales` (`20261105012315`, 754 rows, $48,611, all live at 5:25 PM PT). After: record the version (`SELECT 1` apply under the same name), commit the body as that migration, delete the staged file, ledger, mark this DONE. If the connector declines, do NOT route around it; leave this open.
- **Why:** after the 11-04 delete, 8 `atlas_backfill` rows were still in the 90-day top-100 Top Shot sales ($7,499 / $7,297 / $7,036 / $6,000 / $3,200 / $2,225 / $900 / $800). All 8 have a NULL `moment_id`, which hid them from class 2 ("seller kept the moment" was keyed on the next real sale or ownership). Every one has the SAME seller listing the SAME NFT again after the "sale", 6 of 8 within ~1–2 min — a reprice. Control (seller relists after the sale, 08-10..09-10): onchain 0.13 %, atlas 0.27 %, offer_fill 0.03 %, atlas_backfill 60 %. 7 of the 8 are in this class; the $3,200 one has a buyer and is left.
- **Left after it:** ~260 buyer-NULL `atlas_backfill` rows with NO Atlas events at all (unprovable either way) and every row with a buyer. Do not widen the class without a new instrument.

## STEER — added 2026-11-04 3:28 PM PT (Claude Code cloud) — HANDED TO COWORK: run the staged delete of 4,361 fake Top Shot sales

- ✅ **DONE 11-04 ~5:05 PM PT (Cowork, dashboard SQL editor in Trevor's Chrome; the MCP apply auto-cancelled): 0 / 0 rows left of 4,361 / 1,036, function dropped, recorded `20261105010616_audit_20261104_atlas_backfill_fake_sales_delete`, staged file deleted.** Was: **Run `docs/proposals/atlas-backfill-cancelled-listing-sales-delete-STAGED.sql` as ONE statement batch** (dashboard SQL editor in Trevor's Chrome, or `apply_migration`). It is one DO block + one `DROP FUNCTION`; it RAISEs and rolls back unless exactly 4,361 + 1,036 rows go (two backed-up classes; class 2 added 3:31 PM PT, `20261104233041`). The claude.ai Supabase connector timed out on its destructive confirmation twice (~2:50 and ~3:27 PM PT) with no prompt reaching Trevor — the same shape as the 11-04 index swap. If Cowork's connector declines too, do NOT route around it; leave this steer open.
- 🚨 **WHY IT IS URGENT (read 4:17 PM PT 11-04): 61 of the top 100 Top Shot sales by price in the last 90 days are these fakes, including #1 ($25,000) and #2 ($12,000)** — every "largest sales" leaderboard (`analytics_sales_top_moves`, top-sales boards) is mostly a seller repricing a listing. Run this before anything else in the queue.
- **What it is:** cancelled Top Shot LISTINGS that the 09-09 Atlas recovery wrote into `sales` (ledger 11-04 "4,361 Top Shot sales are cancelled LISTINGS"). Backup already applied: `audit_20261104_atlas_backfill_cancelled_listing_sales` (`20261104224945`, 4,361 rows).
- **Pre-check:** `select count(*) from sales s join public.audit_20261104_atlas_backfill_cancelled_listing_sales b on b.id = s.id` = 4,361, and the same join on `audit_20261104_atlas_backfill_seller_kept_moment_sales` = 1,036 (the seller kept the Moment: re-sold it later or still holds it; control 0.6 %).
- **After:** the same count = 0; `backfill_topshot_sales_from_atlas_events` absent from `pg_proc`; record the migration file named for its version (SQL-editor path: insert the `schema_migrations` row by hand, as `20261102191500` did); delete the staged file; ledger; mark this steer ANSWERED. Spot check `/nba-top-shot/edition/241:8054` Activity: the three @edgede rows gone.

## STEER — added 2026-11-04 2:27 PM PT (Claude Code cloud) — refresh-conflated-editions missed its 7:17 AM PT tick; read the 11-05 tick

- **What fired:** `cron_silent` (medium) on `refresh-conflated-editions` — last run AND heartbeat 11-03 7:17 AM PT, nothing for the 11-04 7:17 AM PT slot (classification `not_invoked`: no heartbeat, so the request never reached the work, or was refused before it). Every other cron-job.org lane fired through the morning (sentinel, sales indexers), so cron-job.org itself was up; the miss is this one entry or this one request. Not today's auth changes: R133 (`79a329cdf`, 9:48 AM) and R150 (10:45 AM) shipped after the slot.
- **No data was lost:** both tables it writes have their own DB writer and are fresh — `topshot_thin_fmv_editions` 20 rows from pg_cron job 63 at 12:30 AM PT today; `topshot_conflated_editions` 66 rows from job 62's detector every 6 h (last 10:23 AM PT). So the deal-board guards were current all day.
- ✅ **ANSWERED 11-05 ~11:45 AM PT (Claude Code cloud): one-off miss — the 11-05 tick landed on schedule at 7:17 AM PT (`ok`, 66 rows); the previous row is the 11-04 6:02 PM PT re-fire. Steer closed.** Was: **Read on 11-05 after ~7:20 AM PT:** a `refresh-conflated-editions` row at ~7:17 AM PT ⇒ a one-off miss, close this steer. **No row again ⇒ the cron-job.org entry is disabled or failing** — open it in the console (Cowork, Trevor's Chrome): history tab shows the HTTP status of the 11-04 attempt; re-enable / fix the header (Bearer INGEST_SECRET_TOKEN).

## STEER — added 2026-11-04 11:30 AM PT (Claude Code local, Trevor's laptop) — Panini old-catalogue backlog: the 3-day check Trevor's cadence decision depends on

- **Trevor decided 11-04 ~10:40 AM PT to keep 6 full runs/day**, on the condition that the backlog keeps clearing. Each night 11-05, 11-06, 11-07, read `panini_editions`: `count(*) filter (where last_seen_at < now() - interval '7 days')` and `min(last_seen_at)`. Baseline 11-04 10:29 AM PT: **18,431** older than 7 d, oldest 2026-10-24 18:47Z. Expected: about −2.5k/day (post-fix rate ~8.3k editions/day vs a 5,750/day break-even).
- ⚠ **Split any rate at the 11-03 6 PM PT fix (`8a143a305`)**: a 24 h window ending before ~6 PM 11-04 pools pre-fix hours and reads ~6.1k/day (CLAUDE.md, "a rate pooled across a fix").
- 📏 **11-05 read (Claude Code cloud, ~11:45 AM PT): 14,755 older than 7 d (−3,676 vs the 11-04 10:29 AM PT baseline 18,431, ~25 h ≈ −3.5k/day — ahead of the expected −2.5k/day), oldest 10-25 1:41 PM PT (was 10-24), 40,267 editions.** On track; reads 11-06 and 11-07 still owed.
- 🔧 **11-05 ~7:00 PM PT (Claude Code cloud): runner walk weighting turned OFF by default** (`PANINI_PRICED_PER_OTHER ?? "0"` in `scripts/ingest-panini-runner.mjs`). Its 10-18 premise — World Cup (2332) the only priced product — expired: 35,013 non-WC editions are priced (17,064 HIGH/MEDIUM), yet 1:1 gave WC's 5,288 cards half the walk (WC p50 33 h, 0 older than 9 d; others p50 103 h, **8,274 older than 9 d**). Takes effect on the laptop clone's next 5:37 AM PT pull. **Read 11-07 with the backlog read:** non-WC >9 d count falling and WC p50 still ≤ ~4 d. **A regression would look like:** WC p50 > 5 d while the non-WC tail is not shrinking — then set `PANINI_PRICED_PER_OTHER=1` on the box and re-raise.
- 📏 **11-06 read (Claude Code local, ~7:10 AM PT): 11,223 older than 7 d (−3,532 vs 11-05 11:45 AM PT ≈ −4.4k/day, ahead), oldest 10-26 7:18 AM PT, 40,302 editions.** Weighting change is LIVE: of editions walked in the last 12 h, World Cup got 257 of 3,327 (8 %, was ~half). By `panini_editions.last_seen_at` (⚠ a DIFFERENT instrument from the 8,274 above, which was FMV-snapshot age; compare 11-07 against THIS line): WC p50 41.8 h, 0 older than 9 d; others p50 90.4 h, **8,048 older than 9 d**. 11-07 read owed (same query: `product_set_id = 2332` split, `last_seen_at`).
- 📏 **11-06 evening interim read (Claude Code cloud, ~9:40 PM PT; same `last_seen_at` instrument as the line above): 8,260 older than 7 d (−2,963 since 7:10 AM PT), oldest 10-27 7:37 AM PT.** Non-WC 35,014: p50 74.5 h (was 90.4), **6,495 older than 9 d (was 8,048)**. WC 5,288: p50 48.6 h (was 41.8), 0 older than 7 d. Last 12 h: WC 443 of 3,195 walked (14 %). Both 11-07 conditions already hold (tail shrinking; WC p50 far under ~4 d) — no cadence re-raise. The dated 11-07 read stays owed to the night pass; WC p50 drifting up toward ~3 d would be expected and fine, > 5 d is the trigger.
- **If the count is NOT falling by 11-07**, re-raise the cadence lever to Trevor (`lib/chains/panini/run-mode.ts`, full every 6 h ≈ +1,000 cards/day; it trades away new-card discovery and pack-page refresh). Detail: inbox `2026-11-02T1900Z` (end).

## STEER — added 2026-11-04 7:22 AM PT (Claude Code local, Trevor's laptop) — HANDED TO COWORK: run the staged wmc index swap; confirm the 11-04 mint-walk run

- ✅ **DONE 11-04 ~8:00 AM PT (Cowork, dashboard SQL editor; record `20261104161510_audit_20261104_wmc_snapshot_cover_takes_the_tier_index_name`).** Was: Trevor approved the swap (11-04 ~7:15 AM PT: "Yes do it", then "Hand that off to cowork"). Run `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` exactly as the file says: each statement in its OWN `execute_sql` call (`CONCURRENTLY` cannot run in a transaction block; no `SET` prefix), the RENAME immediately after the DROP. Why the order matters: `rpc-weekly-wmc-reindex-6` and `run_wmc_reindex_verify()` are the only objects naming either index (prosrc + `cron.job.command` grep, 11-04), and both use the OLD name, which the rename hands to the superset.
- **Pre-read 11-04 7:15 AM PT:** both valid; old `idx_wmc_wallet_coll_ek_fmv_tier` 346 MB, `idx_scan` 105,825,151 (unchanged since 11-03 evening, so unused); superset `idx_wmc_wallet_coll_ek_snap_cover` 284 MB, `idx_scan` 638k. Re-stat both before the DROP.
- **Why Claude Code did not run it:** the claude.ai Supabase connector returned `{"status":"declined"}` on the DROP twice with no prompt shown to Trevor, even after he moved approval to manual. If Cowork's connector declines too, do NOT route around it through another tool; leave this steer open and say so in the handoff.
- **After:** post-check `pg_get_indexdef('public.idx_wmc_wallet_coll_ek_fmv_tier'::regclass)` shows `INCLUDE (fmv_usd, tier, series_number, mint_count)`; record a no-op migration (`SELECT 1;`, the staged file's text as its header, file named for the version `apply_migration` stamps); delete the staged file; ledger entry; mark this steer ANSWERED.
- ✅ **ANSWERED 11-04 12:02 PM PT (Claude Code local):** the 11-04 slot fired from its schedule at 11:59 AM PT (~7 h 22 min late, run `41902184821`, success): ts_minted 5,434 records, ts_subedition 377, ad_minted 0, 436 windows each, 0 left. `checkpoint_nft_meta` max `nft_id` now 53,033,556; 0 Top Shot wmc ids above it. Nothing to dispatch.
- ✅ **ANSWERED 11-04 12:30 PM PT (Cowork):** the 4:37 AM slot fired from its schedule at 11:59 AM PT (~7.4 h late, same GHA lag as 11-03), success; it loaded 5,057 `ts` + 377 `tssub` rows (new max `nft_id` 53,033,556), and all 4 Top Shot wmc ids above the old max 53,028,499 are now in `checkpoint_nft_meta`. Nothing to dispatch. Was: **Also:** list `mint-event-walk-forward.yml` runs. The 11-04 4:37 AM PT slot had not fired by 7:22 AM PT (yesterday's fired ~7 h late). Expect an `event=schedule` run by ~noon PT that loads the 2 Top Shot ids above `checkpoint_nft_meta` max `nft_id` 53,028,499 (first seen 11-04 ~5:13 AM PT). If no scheduled run exists by 11-05, dispatch it and touch the workflow file.

## STEER — added 2026-11-03 ~9:30 AM PT (Claude Code cloud) — #226 mint walk: confirm the schedule fires

- ✅ **ANSWERED 11-03 ~5:55 PM PT (Claude Code cloud, GitHub Actions run list): it HAS now run from its schedule** — run #3, `event=schedule`, started 11-03 11:45 AM PT, success in ~1 min (the two earlier runs were dispatches). It fired ~7 h after its slot, the documented GHA schedule throttling, not a broken trigger. Nothing to dispatch. Original steer follows.
- **Control on that run's "0 records" (Claude Code local, 11-04 6:58 AM PT):** it walked the last 46 windows (152,500,001–169,937,412) and found no mints. That zero is genuine, not a dead walker: only 2 Top Shot wmc ids sit above the checkpoint's max `nft_id` 53,028,499, both first seen 11-04 ~5:13 AM PT, after the run. The 11-04 4:37 AM slot had not fired by 6:58 AM PT; given yesterday's ~7 h lag, judge it after ~noon PT, and expect those ids to land.
- **`mint-event-walk-forward.yml` has never run from its schedule** (11-03 4:37 AM PT slot produced no run; re-dispatched 9:12 AM PT, run `41681990018`). On 11-04/05, list its runs: one with `event=schedule` should exist. If not, dispatch again and touch the workflow file in a commit. Its job: keep `checkpoint_nft_meta` at the chain head so `rpc-topshot-map-checkpoint-reconcile` has chain truth for new Top Shot mints.
- **Expected #226 readings:** `still_disagree` over spork 128 = 0 (1,337,506 / 0 on 11-03); the 597,775 old-range rows without a mint record are NOT a regression (the 10-03 walk never covered them).

## STEER — added 2026-11-03 ~8:55 AM PT (Cowork cloud) — main's history was rewritten for today's 6 commits (privacy purge)

- **If your clone's `main` contains `7911619` (or any of `557f4cc d5ae01a d25b79f 0cdf84c 6d51ed4`), it predates the rewrite. Do NOT push it** — it would put four signups' email addresses back on GitHub. Recover: `git fetch origin && git rebase --onto origin/main 6d51ed4 main` (keeps your local commits), or `git reset --hard origin/main` when you have none. Details + the old→new SHA map: ledger 2026-11-03 "GIT HISTORY REWRITTEN".
- **Never put an email address, wallet owner's real name or other personal identifier in a repo file** — the repo is public. Name users by username (the credential-literal guard catches emails; it does not catch names).

## STEER — added 2026-11-02 ~2:45 PM PT (Claude Code cloud, autonomous session) — expected readings from today's #227 / #221 / writer fixes

- **#227 prune (`20261102214905`):** the next `weekly-wmc-prune` (Sun 11-08 2:20 AM PT) should delete FEWER rows than 11-01's 3,790 — collectors' saved wallets are now exempt (11-02 sizing: 10,775 rows on 9 saved wallets would otherwise have gone). **A regression would look like:** a saved wallet's Top Shot wmc count dropping > 50 % on Sunday and coming back after its next walk (the hold in `snapshot_all_user_portfolios` would then log `held_partial` > 0 on Sunday night).
- **#227 ULTIMATE source fix (`20261102210500`, other session) — first run tonight 10:45 PM PT:** expect 0 `ultimate-v1` → `thin-sales-guard-v3` reversals > 20 % in the 10:45–11:00 PM PT window and edition `260:8827` at the ask (~$675–720), not $3,333. A self check-in is scheduled at 11:20 PM PT to read it and record the result on #227.
- **#221:** `resolve_player_name(<Top Shot>, 'Kenyon Martin Jr.')` → KJ Martin (`matched_via: alias`, father as namesake). Placeholder wmc names (`Unknown Play`, blank) = 0. **A regression would look like:** either count > 0 with `created_at` after 11-02.
- **Writers:** `/api/wallet/seed` no longer writes wmc (it dispatches the multicollection walker; response carries `dispatch`), and `/api/wallet-search` writes degraded rows insert-only. Neither changes a pipeline_runs lane.
- **`pipeline_alerts` `edge_fn_http_error` "4 … HTTP 400 … NOT attributable" (~2–4 PM PT 11-02) is THIS session's Flow REST probes** (pg_net `net._http_response` ids 2134408, 2134426, 2134427, 2134465 — deliberate computation-limit / type-error probes for #138 and the Series 9 sync read). It ages out of the 2 h window by ~4:05 PM PT; nothing to chase. **Same session, same class: the HIGH `pg_net_http_405` row (3 × HTTP 405, empty body, `server: Vercel`, ids 2134849–2134851, 2:22–2:23 PM PT 11-02) is this session's method probes of POST-only routes (`GET /api/wallet/seed` et al.) during the wallet-seed fix; it ages out by ~4:23 PM PT.**
- **Migration auto-recover:** a prod `schema_migrations` row with NULL `statements` (SQL-editor applies) now exits 4: the run commits every recoverable file and then FAILS naming the NULL row — read the step log, the fix is a hand commit, not a re-run.

## STEER — added 2026-11-01 ~8:10 AM PT (Claude Code local, Trevor's laptop) — two readings

- **Inbox `2026-11-01T1545Z` (`panini-ingest-enum` silent ~947 min) — RESOLVED, no action:** the runner is the laptop task `RPC Panini Ingest` (every 2 h, WakeToRun). Every laptop task last ran in one 7:17:17 AM PT wake burst, so the box was off/asleep from ~5 PM 10-31; `panini-ingest-enum` resumed at **7:59 AM PT** (ok, 139 rows). The 738-min threshold fired correctly at `info` — do not recalibrate it for laptop downtime. **A real stall would look like:** the laptop awake (other RPC tasks running) and still no enum row for >12 h.
- **#222 lock-check (`a8537c697`, DB `20261101151627`):** every `lock-check-batch` run now carries `extra.absent_from_chain` (first run 7:38 AM PT: 0). **Expected:** small, mostly 0. **Non-zero = phantom wmc rows** (cached as held, not held on chain) — record the number for #142/#222 ownership work rather than treating it as a lane failure. **A regression would look like:** the field missing again, or `is_locked` flipping to NULL on wmc rows (the function must keep the flag on a null reading).

## ⏬ Older steers rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md): 2026-09-14 and earlier on 2026-09-24; 2026-09-18 → 2026-09-20 on 2026-10-03; 2026-10-03 → 2026-10-15 on 2026-10-24; 2026-10-17 → 2026-10-20 on 2026-10-28; 2026-10-23 → 2026-10-31 on 2026-11-08. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

## STEER — do NOT re-flag these (current)

- **`check_zero_yield_lanes()` flagging `pinnacle-pack-openers` / `pinnacle-metadata-backfill` is BENIGN-INTERMITTENT, not a stall** (dispositioned 2026-10-17). Both write only on Disney Pinnacle pack-opens, which are bursty (a 6-day zero gap 10-03→10-08 self-resolved with a 10-09 burst). Every tick ok=true, 0 gql/write errors. ⛔ Do NOT add a zero-yield suppression (it would blind the 09-12 "ok-while-queues-silent" failure class). Re-open ONLY on ok=false / write_errors / gql_errors, or upstream pack-opens resuming (enqueued/windows_done > 0) with attributed staying 0.
- ✅ **2026-10-04 ~7:13 AM PT: `v_rpc_trust_health` reads 0 breaches** (re-derive before quoting). `public_board_slow_count` cleared once the 4:28 AM PT sweep was clean; its 4 slow readings were the 11:28 PM PT sweep under Flowty load. The three Panini boards that timed out the `panini-boards` snapshot got indexes (`20261004123243`, `…124114`, `…124411`), and the snapshot rebuilt at 5:52 AM PT. The line below is the PRIOR state, kept for history.
- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`) [⏹ **STALE 2026-10-17 ~6:55 PM PT:** the arm is gone from `rpc_trust_health_precompute`, and All Day has **0** open `unmapped_sales` (#160 drained 10-11). The 1,080 open rows are UFC 1,054 (closed market), Top Shot 19 and Golazos 7], `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`. ⚠ **THIS IS ENFORCED: `__tests__/inbox-is-append-only-since-the-rule.test.ts` bans any filing dated on or after the rule from sitting in `archive/`.** ⛔ **And the 2026-08-24 night-pass handoff queued the OPPOSITE** — *"a push-capable pass should archive resolved items"*, calling ~200 live filings *"the accrued cost of the long NO-PUSH streak"*. **They are not debt; they are the intended steady state.** A push-capable pass tried it on 2026-08-24 and the guard stopped it. **Retire a filing by annotating it in place with a ✅ RESOLVED section — never by moving it.**

## STANDING (added 2026-06-22 — do NOT drop on the next focus rewrite) — pg_cron failure check

Every monitor + night-pass health sweep, also run `SELECT * FROM check_pgcron_recent_failures();` — this surfaces the pg_cron-internal failure class that `detect_stalled_pipelines()` CANNOT see (it watches `pipeline_runs`, not `cron.job_run_details`). Empty array = all pg_cron healthy. A listed job is a real finding **only if its `last_run` is AFTER the relevant same-day fix landed**; a failure timestamp that predates a fix is a STALE pre-fix run that clears on the job's next tick — do NOT alarm on it. A genuinely-recent pg_cron failure = HIGH-PRIORITY inbox candidate. (Also permanent in both task SKILL.md health-sweep sections; this note is belt-and-suspenders.)

## SENTINEL DECISION-QUEUE (2026-08-17 PT) — dispositions, so nobody re-derives these

The queue's own warning was that **re-derivation is this project's recurring cost**, and three of its five
items had already been measured elsewhere. Current state:

- ✅ **Item 5 (`pinnacle-nft-resolver`, ~900 null-edition rows) is CLOSED — it is the 08-15 catalog gap.**
  `pinnacle_sales.edition_id` FKs to `pinnacle_editions` (551 rows); the editions live only in
  `pinnacle_catalog` (2,561). Re-measured 08-18T0112Z: `distinct_editions=161 · in_editions=0 ·
  in_catalog=161`, up from 114 on 08-15 (**+41 % in three days**). Filed:
  `inbox/2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-…md`.
  ⛔ **Do NOT "park the unresolvable rows"** — they are not permanently unresolvable, and parking them
  hides a widening gap. ⚠ The resolver's `failed: 0` means it **never reaches** these rows (946 of 954
  have `resolution_attempts = 0`), not that it declines them gracefully.
- ⏸ **Item 1 (pack-EV `fmv_current` JOIN) — mechanism CONFIRMED, still correctly unshipped.** Fully
  measured already in `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`
  (~3,100× — 335 buffers vs 1,046,192). ⚠ **The queue framed this as one coordinated migration because
  "the function is pinned AND two of three are unmeasured". Those two facts are DECOUPLED — verified
  08-18 — and splitting them makes the expensive half shippable on its own:**

  | function | pinned? | measured? |
  |---|---|---|
  | `compute_pack_ev_per_edition_weighted` | **YES** — `supabase/tests/compute_pack_ev_per_edition_weighted.sql`, PINS entry at `__tests__/db-invariants-drift-guard.test.ts:170` | **YES** — jobid 71's callee, confirmed by the timeout CONTEXT; ~100 min/week of `cron_heavy` for zero rows |
  | `compute_pack_ev_from_pool` | no pin file | no |
  | `compute_pack_ev_from_pool_tier_weighted` | no pin file | no |

  So the **pinned one is the measured one**, and it is the one actually burning the budget. It can ship
  alone (migration + pin `.sql` + repoint the PINS migration name); the two unpinned ones need
  measurement but **no pin work**, and must not gate it. ⛔ Never `CREATE OR REPLACE VIEW fmv_current`
  (resets `security_invoker`); fix the CALLERS via a lateral accessor. Measure in a quiet window —
  during a saturation spell no timing is interpretable.
- 🔑 **Item 2 (`wallet-username-resolver`) is OPERATOR-ONLY — it is not pg_cron.** Caller enumerated
  08-18: absent from `vercel.json` (36 crons), pg_cron (94 jobs), GHA and in-repo fetches. It is
  **cron-job.org**, firing `POST /api/cron/resolve-wallet-usernames` 2×/hour. Trevor chose lever (a),
  cut the cadence → **every 3 h**. Sizing: 72.3 % of runs fail, and the failures still pay the full
  21-day `sales` scan before `wallet_usernames_unresolved`'s `statement_timeout=60s` kills them, for
  ~31 usernames/day. ⚠ Cadence only — **do not narrow the 21-day window** (breaks the 14-day retry).
- 🔍 **Item 3's lever is NOT the index alone.** The cost is in `aggregate_saved_wallet_stats`, whose
  `top_tier` **correlated subquery re-scans `wallet_moments_cache` once per `collection_id`**, and no
  index carries `tier` (confirmed: 14 indexes, none include it; `idx_wmc_cohort_cover` is now **464 MB**,
  not 458). Fold the subquery into the existing `GROUP BY` before considering a wider index — a fold
  costs no write amplification on a 98 %-non-HOT table.

⚠ **Measurement hygiene, learned the hard way 08-18:** the Supabase MCP 60 s cap abandons the RESULT, not
the query — a "timed out" EXPLAIN keeps running (seen at 86 s) and retrying it stacks copies onto the
saturation being measured. Take a positive control first (`count(*) FILTER (WHERE wait_event_type='IO')`
over `pg_stat_activity`); if most active sessions are in IO wait, **every duration that hour is
uninterpretable** — compare Buffers, never wall time.

## STANDING — read the three daily instrument LOGS, not their badges (added 2026-08-22)

Three credentialed detectors run daily and are the only things that can see their rot classes:
`edge-fn-drift` (06:40Z) · `db-pin-staleness` (07:20Z) · `migration-parity` (07:40Z). **Measured 2026-08-22:
edge-fn-drift red 14 consecutive runs, db-pin-staleness red 13, migration-parity 14/14 green — and BOTH red
ones are LOUDLY CORRECT, not broken.** 25 edge functions are not running `main`; 6 of 187 DB pins no longer
match live. Details: known-issues **#23**, **#24**.

⚠ **Nothing surfaces them (#25).** The sentinel — the thing actually read — has no GitHub Actions arm, so a
correct detector can stay red indefinitely and nobody notices. Until that is fixed, **reading these three
logs is a MANUAL step in any health sweep**, and CLAUDE.md's rule applies literally: *check the LOG, not the
badge* — a permanently-red instrument and a broken one look identical.

✅ **#24 is RESOLVED as of 2026-08-22 — all six pins re-pinned, assertions reviewed, not merely repointed.**
The warning that stood here (repointing without reviewing the assertions converts a working alarm into a
silent green) was honoured: every pin got its own diff, and five gained mutation-tested assertions for the
behaviour that had drifted. ⚠ **VERIFY, do not assume:** the 07:20Z `db-pin-staleness` run should now report
**187 clean, 0 needing attention** — its first green since 2026-08-03. If it names a pin instead, read WHICH
before reopening. 🚨 **IT DID NAME PINS — this prediction was FALSIFIED on 08-23 and the reason is durable;
see the 2026-08-23 STEER above.** Closure is a moment, not a state: a same-day rewrite of a pinned function
re-opens the instrument within hours. Recipe + what the six taught: [database.md](../reference/database.md).

⚠ **#23 and #25 remain OPEN and are operator-blocked.** 25 edge functions are still not running `main`
(redeploy needs both `deno.json` in `files` AND `import_map_path`, or a stale-but-working function goes
hard-down — and the list includes off-limits `compute-*-pack-ev` / `ingest-*`). Nothing still reads the
daily detectors; that fix is a sentinel arm keyed on a failure STREAK, blocked on putting a GitHub token
with `actions: read` into Vercel env.

## DECIDED 2026-08-22 — two open decisions closed, so nobody re-opens them

- ✅ **pg_cron jobid 70 / the `cron_heavy` privilege question: do NOT grant, no grant is needed.**
  `postgres` IS a member of `cron_heavy`, and `cron_heavy` already holds EXECUTE on `cron.schedule` and
  `cron.unschedule` — only `cron.alter_job` is missing, and `cron.schedule` upserts on
  `(jobname, username)`, so rescheduling under the job's own role updates it in place. Granting
  `alter_job` would widen a privilege to buy a capability the role already has by another door.
  ⚠ **The blocker is the HARNESS, not the database** — the Claude Code auto-mode classifier denies
  `SET ROLE`. The two-line self-checking recipe (and what to do if it returns a jobid other than 70) is
  in **known-issues item 19**, which has been corrected: its old "NO session-reachable role can
  reschedule" headline was **REFUTED**. **Transferable:** *"the sandbox could not do it" is not evidence
  that the DATABASE forbids it* — that conflation turned a two-line fix into a privilege-grant proposal.
- ✅ **The FMV-confidence accuracy meter: the destination is a NIGHTLY MATERIALISED TALLY**, not a
  cheaper in-band query. Rationale in §7 of
  `inbox/2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-…md`. The short form: a
  3.3× cheaper query still runs in-band and can still be killed in a spell — it lowers the odds without
  removing the dependency; and **a GATE metric needs a SERIES, which the in-band rewrite does not
  provide at all**. ⚠ **The lateral rewrite is NOT the alternative — it is the tally's WRITER**, so the
  23:10Z measurement (`trig_01H3p6o5iB7yyjLVzrbbviaA`) keeps its full value and has been repointed at
  that question. ⚠ **The tie check is now BLOCKING**: a tally is computed once and read all day, so an
  arbitrary tie-break is frozen into the published number. ⚠ **New third state for the redesign:
  STALE** — a stored tally that silently ages is worse than a query that loudly times out, because a
  timeout is falsifiable. Nothing has shipped: no table, no writer, no migration.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
