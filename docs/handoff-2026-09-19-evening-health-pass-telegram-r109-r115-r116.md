# Handoff — 2026-09-19 ~5:30 PM PT · evening health pass: the pager's Telegram channel, R109's decisive test, the confidence precompute, `portfolios`

**Session:** Cowork cloud + laptop VM, Trevor-directed ("run a health check … address as many issues as you can"). **Push:** path A (laptop VM, `.rpc-git-cred`) — proven by `ls-remote == HEAD` on `d1c11a79c`. All times **PT**.

> ⚠ Any push-capability note in this file is specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager. **Commit the migration files as usual.**

## Health verdict — the board reads worse than the estate

**HEALTHY since noon.** Every `high`/`medium` `failure_rate` row on `get_pipeline_alerts()` straddles this morning's IO spell (a 2-day window). Split on the change point:

| instrument | before noon | since noon (5 h) |
|---|---|---|
| `cron.job_run_details` failures | 30–108 / h | **0** (~405 runs/h, every one `succeeded`) |
| `pipeline_runs` fail rate | 1.85 % (157 / 8,502, 12 h) | **0.31 %** (11 / 3,589) |
| `rpc-ts-listings-atlas-sync` (R101) | 257 fails / 24 h | **161 / 161 ok** |
| backfill-pack-rip-metadata · fmv-backfill · lock-check-batch · run-insider-detectors · allday-buyer-backfill | 63 % · 50 % · 45 % · 44 % · 33 % failing (2-day) | **5/5 · 2/2 · 11/11 · 5/5 · 2/2 ok** |

Security 0/0/0/0 · stalled pipelines 0 · the three Atlas lanes are active again (the thread-close handoff's item 1 — resolved before this session, no entry names who). Sentry: nothing in 24 h, **paired with Vercel: 50 groups / 24 h, all long-standing shapes, newest 4:47 PM PT** — the `[pack-detail] … read exceeded 5000ms` family (1,421 / 24 h on `/[collection]/pack/dist/[distId]`) still fires post-noon and is the next user-facing cost; **not addressed here**.

Two trust breaches at write time: `trust_precompute_max_age_hours` 23.2 h (jobid 324 runs at 5:48 PM PT — see watches) and `public_board_slow_count` 2 (an instrument memory says lies; not chased).

## Shipped (4 items)

1. **Telegram delivery restored + the class closed** — `d1c11a79c` (CI green) + a prod data repair. The pager's Telegram channel was dark **12:04 PM → 5:07 PM PT** because the `Cadence Collapse` ack reason (written 9:13 AM PT, expiring 10-01) contained `baseline_per_day < 400`, interpolated raw into a `parse_mode:"HTML"` message. Email still delivered. Data: `< 400` → `below 400`. Code: `escapeTelegramHtml()` + `renderSentinelTelegramLine()`, test reproduces the live fragment. ⚠ `lib/ops-alert.ts` has the same exposure and is **not** changed (callers may pass intentional markup) — queued.
2. **R109 decisive test** — `step1` **25.0 s**, `step2` **30.4 s**, `daily-portfolio-snapshot`'s aggregate **5.2 s** (read-only) on a quiet box with `wallet_moments_cache` `relallvisible` = 1.000. The 600 s / 300 s / 120 s kills were the estate, not the statements. **Both cross-collection mats are fresh; the staleness guard reads [].** Probes 528/529 unscheduled.
3. **R115 + R116** — migration `20260920001632`: jobid 506 gets `SET statement_timeout = '300s';` (jobid kept), the loop derives its collections, Pinnacle reads `pinnacle_fmv_history`, `coalesce('{}')` gone, `rpc_ops_snapshot()` derives its two keys and adds `fmv_by_collection_note`, the function writes `pipeline_runs`. **Control run: 6 rows, Candy 62.4 %, Pinnacle 28.0 % — the filing's falsifier to the decimal.** Structural half of R115 (78:1 DISTINCT ON) still open.
4. **`portfolios` anon write grant revoked** — migration `20260920001811` (thread-close item 5). Anon write-grant set now reads exactly 4, all INSERT-only.

Ledger entry (top of `docs/overnight/ledger.md`) carries revert paths for all four. Register rows R109 / R115 / R116 updated; `check-register-integrity` green.

## Watches (exit · falsifier)

- **jobid 324 `rpc-thp-leg-impossible-parallel`, 5:48 PM PT** — exit: `trust_precompute_max_age_hours` < 13 · falsifier: a 600 s kill on a quiet box means the leg's own cost moved (it was 35–52 s on 09-18/19 00:48Z).
- **jobid 506, 6:35 PM PT** — exit: `succeeded` under 300 s, `nba_top_shot` `duration_ms` well under 200,000.
- **step1 at 3:02 AM PT** — read `relallvisible/relpages` for `wallet_moments_cache` at ~3:00 AM first; exit `succeeded`; a kill with the map still ~1.0 re-opens contention as sole cause.
- **jobid 490 at 4:17 AM PT** — a new `portfolio_snapshots` row (second half of the `portfolios` exit).
- **Next sentinel sweep** — `notifications` contains `telegram`, not `telegram-FAILED`.

## Second half of the pass (5:45–6:10 PM PT) — verified, then shipped two more

- ✅ **Telegram is back.** The 6:04 PM PT sentinel sweep recorded `notifications: ["telegram","email","github-actions-native"]` against `telegram-FAILED` on every sweep since noon. (The `Alert Delivery` arm still reads warn for a while — it inspects the last 12 attempts.)
- ✅ **`trust_precompute_max_age_hours` 23.2 h → 5.09 h (ok).** Watched the 5:48 PM PT tick: leg 324 and jobid 65 (`rpc-allday-ev-corrected-refresh`, `47 */6`, the same four hours) ran together, drove the box from io_wait 0 to 7, and finished at 272 s / 374 s — survivors only because nothing else contended; on 5 of 6 shared ticks since 09-18 both died at 600 s. **Shipped `20260920005312`: leg 324 moved `48 → 31 0,6,12,18`** (measured least-loaded minute; the old "healer 219 must run before 324" ordering is moot — 219 was retired 09-12). Exit: the 11:31 PM PT tick tonight, then 5:31 AM / 11:31 AM PT, `succeeded` with the arm under 13. ⚠ **Corrected 6:45 PM PT (Claude Code, Windows box): this line first read “6:31 AM / 12:31 PM PT”, which is an hour off.** `31 0,6,12,18` is UTC; PDT is UTC−7, so the four ticks are 5:31 PM / 11:31 PM / 5:31 AM / 11:31 AM PT. The 00:31Z tick (5:31 PM PT) fired BEFORE the migration applied at 5:53 PM PT, so the first tick under the new schedule is 11:31 PM PT tonight — not a morning one.
- ✅ **`lib/ops-alert.ts` escaped too** (`3b884ec23` on main) — its callers pass data-built plain text (the smoke-test detail carried `<!DOCTYPE html>` during the 09-18 outage). Two other `parse_mode:"HTML"` senders (`alerts-send`, `detect-league-drift`) are **not audited**.
- 🧾 The `[pack-detail] read exceeded 5000ms` family is 25 in the 5 h since noon (1,421/24 h), and the survivors are mostly the smoke fixture `dist/5048` with `cache=BYPASS` every ~10 min. `get_pack_lifecycle_row('5048')` is 19 ms warm / 2.0 s + 3,441 physical reads cold — IO, not the query. Not fixed.
- 🚫 `pg_visibility` cannot be installed (superuser only) — thread-close item 6 closes as unreachable.
- Sentinel at 6:04 PM PT: **CRITICAL on one arm only** (`Pipeline Success Coverage`: daily-portfolio-snapshot / golazos-buyer-backfill / match-topshot-players — all 24 h-window readings from the night spell; the first two re-test at 4:17 AM PT and their own next ticks, the third retries Saturday). Warns: Alert Delivery (lagging), Detector Health (acked), Dune (configured stop), pg_net #75, Golazos 0 sales/7d (market), `public_board_slow_count=2` (instrument), Wall Kills, Zero-Yield.

## Third pass (6:40–6:55 PM PT) — the sentinel arms one by one (Trevor: "address all you can from sentinel")

- 🚨 **`daily-portfolio-snapshot` — the "permanent gap" never existed.** `portfolio_snapshots` has 27 rows for each of 09-16…09-19, written by pg_cron jobid 490's 11:17Z retry while the 07:05Z route died; the retry wrote no `pipeline_runs` row, so the arm and inbox 1745Z read the route's failure as the day's outcome. Only 09-12 is missing. `20260920014230`: the retry now logs under the route's name. R109's row corrected.
- **`golazos-buyer-backfill`** read 164 MB of `sales_2025` daily to find zero null-buyer Golazos rows. Partial index `idx_sales_2025_null_buyer_coll_sold`: 21,474 → 471 buffers. (The 2026 twin was built, measured useless for the All Day ordered scan, and dropped.)
- **`match-topshot-players`** — weekly full run hand-dispatched: **12.9 s** (the 08:00Z attempt died at the 125 s PostgREST gateway in the storm). Tomorrow's tick is a gated ok.
- 🟠 **Pipeline alert `backfill-pack-rip-metadata`** — every failure was a 30 s service_role kill inside the spells; healthy 5–9 s. `20260920014006`: function-level `statement_timeout = 50s` (inside the route's 60 s wall). 6:53 PM tick: 5.3 s ok under it.
- **`public_board_slow_count=2`** = `candy_special_serials_board` 5.2 s + `pack_table_rows` 4.5 s. Candy board: partial index `idx_sales_2026_candy_edition_serial_sold` → view 42,070 → 12,742 buffers. `pack_table_rows` untouched.
- **Zero-Yield** — three correct zeros suppressed with re-check conditions (`20260920014558`): pinnacle-sales-history-backfill (spork floor), golazos-sales-indexer (live reader, empty market — the >168h Sales Ingest warn stays visible on purpose), sales-seller-recovery-dune (Dune stop; expires ~09-24).
- **Wall Kills** — both lanes were storm kills, at 6–7 clean runs of the 10 the arm wants; clears on its own.
- **pg_net 10.2 GB (#75)** — measured for the decision: heap 7 MB / TOAST 10 GB / 5,665 live rows; postgres holds MAINTAIN so `VACUUM FULL` is runnable, but it needs ~8 min of ACCESS EXCLUSIVE (pg_net blocked) and the R108 role-window recipe (no SET prefix possible). Trevor's go.
- All `zz-%` one-off jobs unscheduled; migration guards green locally.

## Fourth pass (7:00–7:20 PM PT) — decisions taken on "do what you think is best"

- 💰 **R107 fixed.** `edition_fmv_current`'s full reconcile was unreachable (gated on an empty table); now `refresh_edition_fmv_current(p_full)` + daily `rpc-edition-fmv-current-full-reconcile` (cron_heavy, 2:36 AM PT) with a `pipeline_runs` row. First run 45 s: drift guard 1 → 0, orphan pairs 105 → 0, 15 prices corrected (net −$271, max −$1,349.55). Backup table kept 30 days. The "do not point more boards at this table" ban is lifted to "gate on the drift guard".
- 🗄 **#75 done.** `VACUUM FULL net._http_response` ran in **7.7 s** (live tuples only — the 10 GB was dead TOAST): 10 GB → 469 MB, database 29.1 → 19.0 GB. Weekly from now (Sunday 2:43 AM PT). Memory corrected.
- ⚡ `candy_special_serials_board` 42,070 → 3,516 buffers (index + a partition-pruning `sold_at` bound).
- 🔍 All `parse_mode:"HTML"` Telegram senders now escape (alerts-send and detect-league-drift already did).
- 📏 `pack_table_rows` measured (35 k buffers, CPU-bound, pinned view) — not changed.
- Not taken: dropping `portfolios`/`portfolio_moments`; Golazos threshold; backfilling 09-12's snapshot.

## Fifth pass (7:20–7:45 PM PT) — the structural residuals, and a stale register cell

- 🚪 **R98 closed** (`66089747d`, deployed READY). The register still called the `/api/cache-refresh` half "UNSHIPPED" a day after `cd0ab66a1` shipped its per-wallet cooldown — corrected from `git log`. What was genuinely open: a client naming a *different* whale each call. Now bounded per client key, 12/min sliding, 429 + Retry-After **before** the cooldown read (a refused call costs no DB read). Mutation-proven; six suites + tsc + ratchet green. Per-call cost of one whale wallet deliberately untouched (the "Last updated" contract).
- 🧭 **Matcher's weekly full run has a pg_cron home** (`20260920022633`, jobid 543, 12:32 AM PT, 300 s prefix, no gateway). The 08:00Z edge tick becomes the gated daily check. Probe as the production caller: row written, gated, 35 ms.
- 📸 **Portfolio snapshot re-designed around the day, not the caller** (`20260920023318`). The aggregate is scoped to users without today's row (done path: 34 buffers / 13 ms, wmc scan `never executed`); pg_cron primary jobid 546 at **11:46 PM PT**, the 12:05 AM route and jobid 490 (4:17 AM) become millisecond retries. Probes: 27 rows / 4.4 s, then 0 / 33 ms. ⚠ 09-20's snapshot is therefore stamped 7:34 PM PT (the probe), not 11:46 PM — a one-time shift, not a gap.
- ⚠ A 3-minute spell at 6:28–6:31 PM PT killed two pg_cron lanes (121 s / 120 s) and one `refresh_wmc_fmv_changed`; all recovered by 6:32. Unattributed (possibly my EXPLAIN probes — no IO-history table exists to check). Recorded in the ledger so it is not read as a regression.
- CI: `e7c8372a8`, `66089747d`, `33fe4d9bb`, `d63e04367` all 21/21 green; `79b33a55c` building at 7:45 PM PT.

## Sixth pass (7:45–8:00 PM PT) — R115 closes structurally

- 🏁 **R115 structural half shipped** (`20260920024430`). With R107 closed, `edition_fmv_current` is the newest-snapshot-per-edition table, so the confidence precompute reads it (21k rows) instead of streaming 1.1 M `fmv_snapshots` rows through a DISTINCT ON. Equivalence proved per edition (2,068 disagreements, every one newer than the cache's last refresh; 0 behind-but-older, 0 missing). In-migration control as the job's role: **Top Shot 5,286 ms → 31 ms**, Candy 62.4 % and Pinnacle 28.0 % unchanged to the decimal, Top Shot HIGH+MEDIUM 52.7 %. Provenance columns `source` / `source_newest_computed_at`; `efc_drift_rows` in each run record. Exit: the 10:35 PM PT jobid 506 tick.
- 📉 Read the Windows-box session's #126 entry (four lanes stepped on 09-17 16:52Z, instance-level, diurnal 02–18Z bands, cause not established). One candidate worth a falsifiable watch rather than a claim: `net._http_response` carried **10 GB of dead TOAST** until tonight's VACUUM FULL (7.7 s, → 469 MB); autovacuum re-walking that much dead TOAST on a 22 MB/s tier is the right shape for a slow-reads band. **If the 02–18Z band does not return on 09-20, that was the mechanism; if it returns, it was not.** No stats survive the rewrite to prove it either way tonight.
- CI: every commit through `d63e04367` 21/21 green; `79b33a55c`/`43b1cee32`/`4c0296bfd` in flight at 8:00 PM PT.

## Seventh pass (8:00–8:40 PM PT) — visibility maps, and the two spells I caused

- 🧹 **Nine rotten visibility maps found by the free instrument** (`relallvisible/relpages` < 90 % on tables > 5,000 pages). Seven vacuumed in 2–12 s each to 99–100 % (`sales_2025` had **never** been autovacuumed since the stats reset), thresholds set to 0.02 on eight tables (`20260920031313`) so they stay clean. `sales_2023` finished under autovacuum at 8:23 PM (→ 100 %).
- ⚠ **Two self-inflicted spells, filed as such:** the two manual VACUUM scans of `sales_2023`/`pack_rips` (8:07–8:11 PM, both killed at 120 s) cost five lane failures; then the unthrottled `pack_rips` autovacuum the new threshold triggered cost ten `job startup timeout` rows at 8:18 PM and seven more at 8:30 PM even after pacing. **~30 lane failures tonight are mine**, all self-clearing, no data lost. Lessons written down once each: on this tier a manual VACUUM of a ≥ 300 MB table is a spell even when it fails; a 0.02 trigger on a table with > 500 MB of indexes must ship with a per-table cost throttle sized on PG14's `vacuum_cost_page_miss = 2`; `ALTER TABLE … SET (reloptions)` is the only cancel button for a running autovacuum from `postgres`.
- ⏸ **`pack_rips` autovacuum paused** (`20260920033248`); a self-unscheduling pg_cron job (jobid 560) re-enables it at **1:12 AM PT**, the measured quietest hour, throttled at 50/50. If that pass still steps startup timeouts, the lever is `pack_rips`' 11 indexes (1.28 GB on 764 MB), not pacing — open a register item.
- Estate at 8:37 PM PT: 0 failures in the 29 cron / 38 pipeline runs since the pause; the box's own routine load (wmc autovacuum, jobids 303/215) had the IO after that.

## Eighth pass (8:40–9:00 PM PT) — the cron console from Chrome, #32, and the second author of the spells

- 🗓 **cron-job.org swept read-only from your Chrome** (guard-safe: titles/status only): 88 entries, 71 active, **17 inactive — the same deliberate 17 as at noon; nothing was auto-disabled by tonight's spells.** `RPC Pinnacle NFT Resolver` failed 5 of 50 executions, all inside 8:16–8:41 PM, healthy at 7–11 s otherwise. No console writes were needed.
- 🔁 **#32's premise is stale**: the installed `rpc-cron-ops` skill is already the 09-13 text (secret rule present). The real defect was two-way divergence with the repo source (each had lessons the other lacked) plus a false "~2 runs of history" claim. Merged into one text, bundle re-packed, **a skill-update card is waiting for you in this session — saving it closes #32.**
- 🔁 **The evening spells had a second author.** The weekly wmc REINDEX wave (jobids 438–441, 477, 478) runs **Saturday 7:03–8:43 PM PT** — inside the band every 7-day average called quiet. My pack_rips pass and its 399 MB leg (-5) collided at 8:23–8:33 PM; the REINDEX died at 600 s and left an invalid `_ccnew` (dropped, 1.8 s). **-6 (jobid 478) had pointed at an index dropped on 09-14 and failed for the first time tonight — re-pointed at its successor** (`20260920035444`). The 8:38–8:43 failures after that were the box's own routine wmc autovacuum + jobids 303/215.
- Watches added: Sunday 8:43 PM PT jobids 477/478 both succeed and the 9:03 PM verify reads `invalid_left = 0`.

## Ninth pass (9:00–9:35 PM PT) — R117 and the pack-detail timeouts explained

- 🔎 **R117 filed:** `wallet_moments_cache` autovacuum ran nine passes ≥ 10 min on 09-19 totalling **~3.4 h**, each a full pass over its 2.2 GB of indexes, in #126's slow-reads band. Durations ARE recoverable from `postgres_logs` (`parsed.session_start_time` vs `parsed.timestamp`) — the 08-29 note said they were not. No lever moved; all 19 wmc indexes are read, two prefix-redundant siblings are ~9 % of the total, so pass count is the lever (with the heap-fetch falsifier).
- 🔧 `run_wmc_reindex_verify()` now names `idx_wmc_wallet_coll_ek_fmv_tier` in lockstep with jobid 478 (`20260920041743`, md5-parity checked). Tonight's verify `ok=false` is the 43 % leaf density on `idx_wmc_lock_wallet_coll_cover` (its REINDEX died under my pass) — clears next Sunday if jobid 477 succeeds.
- ↩ **Two of the eight 0.02 tables were churn tables** (`allday_pack_sales_history` 13.7 M updates, `topshot_pack_sales_history` 21 M): allday autovacuumed seven times in 70 minutes. Backed off to 0.1 (`20260920042528`) — hourly passes instead of every ten minutes, still 5× the old cadence. Exit: counts advance ~24–30 by tomorrow evening, maps > 90 %.
- 🎯 **The `[pack-detail]` 5 s timeouts (186 errors / 3 h, top route by 6×) are the pack_rips visibility map:** the All Day lifecycle read is an Index Only Scan with 4,128 heap fetches on 5,919 rows, 1,368 disk reads, 5.6 s. A crawler is walking ~93 distinct All Day pack pages at one per 10 s, each a cold ISR miss. The 1:12 AM PT throttled autovacuum is the fix and now has a user-facing exit: those errors drop from ~60/h to ~0.

## Tenth pass (9:40–10:10 PM PT) — the product's hottest query shape gets its cheap twin, and the routes move onto it

- 🎯 **`get_editions_latest_fmv_wide(uuid[])`** (`20260920044216`): the narrow helper's per-id LATERAL selection rule returning all 15 `fmv_current` columns, service_role only. Why: pgss since 08-11 shows the 5-column id-list read of the view at **6,103 calls · 6.2 s mean · 631 min of DB time**; the view's DISTINCT ON walks ~76 snapshots per edition before Unique keeps one. Hand A/B on a fixed 100 Top Shot ids: view **40.9 s cold / 22.6 s warm (~7,400 buffers)**, helper **40 ms (1,617 buffers)**, set difference **0 both ways**. The first apply died at the 60 s MCP cap because it carried the A/B in-migration — re-applied without it.
- 🔧 **`wallet-search` ×2 and `cache-refresh` repointed** to `.rpc("get_editions_latest_fmv_wide", { p_edition_ids: chunk })` (`fa8ca839c`). The five fixture files moved their `fmv_current` key to the harness's `rpc:` key — a rename, not a re-shape, because the harness returns the same `{ data, error }` envelope. Mutation-checked: a misspelled rpc name fails 4 tests in 2 files; 15 suites that import either route pass (116 tests); tsc clean; lint ratchet 712 = baseline. `database.md`'s "not worth a migration" section records the re-litigation (the total moved, not the rule).
- 📝 `fetchFmvBatch` and `/api/fmv` remain on the view; same one-line edit, but each has a guard suite that names the view (D27) and should be re-pointed deliberately.
- **Exit:** by 09-21 pgss shows the view's 5-col shape no longer accruing and the helper at a mean < 200 ms; `[wallet-search]` / `[cache-refresh] fmv lookup err` → ~0. **Falsifier:** a p90 wallet still > 5 s ⇒ chunk COUNT (60 parallel chunks of 50), raise `CHUNK` before blaming the helper.
- **Revert:** `git revert fa8ca839c` (routes + fixtures + doc paragraph); `DROP FUNCTION public.get_editions_latest_fmv_wide(uuid[])` only after that.

## Needs Trevor

#22 purge residue · #55 the two 2-hourly Routines · jobid 303 `refresh_wmc_fmv_changed` as the #1 reader (FMV path) · whether to retire `portfolios` + `portfolio_moments` outright (option b), now that the grant is gone · the Golazos `>168h` sales-ingest threshold vs a market that sells every ~10 days.

## Not done, deliberately

the `[pack-detail]` 5 s read timeouts (mostly the smoke fixture measuring itself) · `pack_table_rows` view shape (pinned; 35 k buffers CPU-bound) · an `updated_at`/version column on `fmv_snapshots` (the daily full reconcile bounds the hide time at ≤ 24 h) · backfilling the missed 09-12 `portfolio_snapshots` day (an absent point is more honest than an interpolated one).
