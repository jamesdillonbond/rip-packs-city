# Overnight pass — 2026-11-22 (~12:50–1:10 AM PT)

**Verdict: GREEN. Shipped 0, reverted 0. A quiet, honest night.** Every post-ship watch owed from the 11-21 evening index wave is holding or clean; health is green with 0 trust breaches; the only new candidate and the one new health finding are both correctly QUEUED (route-logic / guard-claim = off-limits for the autonomous pass).

## Run context
- **Genuine overnight**, clock verified no-skew: shell 09:02Z / DB `now()` 09:05Z / newest sale 09:03Z / newest FMV 08:55Z — all within 3 min (≈ 1:05 AM PST).
- **Push AVAILABLE** via the laptop-VM `.rpc-git-cred` route (dry-run `origin main` exit 0; `ls-remote` = clone HEAD `ba0fc0cfa`). No cloud `add_repo` tool this session. Not frozen.
- Lock was RELEASED (prior `cowork-20261121T090254Z-12413`, pushed `3b695ecd4`); taken over as `cowork-20261122T090317Z-15772`, released at end.
- **Stranded-output sweep CLEAN:** `ledger.md`, `flow-ecosystem-watch.md`, `metrics-latest.json` all hash-match origin; the one new mount handoff (`handoff-2026-11-21-sales-completeness.md`) is already in origin; `origin/main` `ba0fc0cfa` unchanged start→end.

## Reviewed
- **Inbox drained:** 1 new file since the 11-21 overnight pass — `2026-11-22T0440Z-…-wallet-held-pack-value-times-out-on-large-pack-wallets.md` → **QUEUED** (see below). No mount-only inbox files (mount == clone). Inbox left untouched (append-only); disposition recorded here per the rule.
- **Ledger / focus / recent handoffs** read: the 11-21 evening pass shipped 3 lane fixes + 6 index rebuilds + the fmv-recalc migration; tonight's focus steer is entirely the post-ship dated reads for that wave.
- **Post-ship regression watch (the main job tonight):** 5 dated reads, below.
- **Health triage:** `rpc_ops_snapshot()` baseline + deltas + Vercel + runtime errors + client-error beacon, below.

## Post-ship watch — 11-21 evening wave: ALL CLEAN / HOLDING, 0 reverts
1. **`analytics_packs_summary` PostgREST 500s → 0.** edge_logs 04:00–09:10Z: 9 origin calls, **all 200, zero 500** (was 11 in the 24 h before). The `pack_ev_history` 3-index reindug (543→171 MB) is holding; `public_board_slow_count`/`public_board_empty_count` both 0, `pack_ev_board_max_stale_days` ok.
2. **`ts-listings-atlas-sync` sync step → faster.** Median `extra.sync.duration_ms` since 04:05Z = **3,363 ms** (was 4,595 ms, −27%; p90 5,808, max 18,968). The `topshot_atlas_market_events` cover reindex (495→73 MB) is holding.
3. **`fmv-recalc` migration `20261122042722` — NOT a regression.** Apparent "2/15 errors post-fix vs 13/235 pre-fix" is a sampling artifact: the `historical_fallback_error` (statement timeout, `hist_rows` honestly 0) is confined to the **`:08` bi-hourly deep-historical pass**, and **`01:08` + `03:08` (both PRE-fix) also timed out**, so the fix neither introduced nor worsened it. Every run is `ok=true` (main recalc leg succeeds); the migration's verified claim (1.18M→698k buffers, identical output) is intact. The deep-pass timeout is a pre-existing, honest, non-fatal condition — see QUEUE note.
4. **`topshot-onchain-art-backfill` `7f4c6e06` — too early, within window.** `legacy_resting` not yet engaged ~5 h post-deploy; no completed zero-fill lap since the ~7:40 PM PT deploy, so the rest hasn't triggered (expected within 12 h of 10:22 PM PT = by ~18:22Z). Runs still full-length (60–85 s, 0 fills) = pre-rest behavior, not a regression. **Re-read next overnight:** `extra.legacy_resting` / `legacy_rest_until` should be set, run duration should drop.
5. **Panini MV lanes after the `idx_panini_serials_edition_agg` rebuild (4 runs each since 04:48Z):** `panini-squeeze-mv` **11.9 s** (was 16–20 s, improved); `panini-offer-spread` **17.9 s** (vs 13.4 s 72 h baseline) and `panini-market-board` **24.0 s** (vs 22.2 s) — above baseline but inside range (max 33.8 s / 31.1 s), 0 fails. Partly `panini_editions` +1,494 growth (MV refresh scales with table size). **offer-spread stays the trace cue** (`mv_panini_offer_spread` plan) only if it is *sustained* over a full 24 h median, which 4 runs do not establish.

## Health-drift triage — GREEN
- **Security:** `invariants` [], `anon_write_holes` [], `rls_off_base_tables` [] (independently re-confirmed via direct `pg_tables rowsecurity=false` catalog SQL — 0 rows), `secdef_anon_violations` []. All drift legs [] (search_path, txn-control, cursor-rewind, suppression ×2).
- **Trust health: 0 breaches.** Last night's 3 candy-cleanup breaches all self-cleared as predicted: `candy_ask_book_drop_pct` 93.7→**4.5**, `candy_offers_oldest_active_hours` 999→**2.2**, `candy_offers_unverified_pct` 999→**0**. `edition_integrity_flags` 8/ok, `fmv_sanity_flags` 0, `topshot_impossible_parallel_serials` 0, `unmapped_resolution_backlog_max` 0/ok.
- **Stalled:** 1 **info false-positive** — `fmv-clamp-disconnected-ask` (see FINDING). **Pipeline alerts:** 0 HIGH/CRITICAL; 3 info (2 known Atlas-403 base-rate + the fmv-clamp cron_silent). **pipeline_fails_24h:** topshot-pack-supply-atlas 26 (designed Atlas challenge), atlas-pack-market 9, snapshot-pack-asks 3 (upstream 3), rest 1–2.
- **Sentinel:** `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **Vercel:** prod `dpl_CxJ2fK4SngnhNSYnu4QAWGhXfove` = `7f4c6e06` **READY** (rollback candidate); 6 newest tips CANCELED (docs/db-only via ignoreCommand, expected); no ERROR. Runtime errors 24 h: 10 groups, all count 1–2, all isolated read-timeouts degrading honestly — no new cluster, none traceable to a last-night ship.
- **Client-error beacon:** `usage_events feature_name='client_error'` 0/24 h.
- **Deltas vs 11-21:** DB **58,374 → 55,730 MB (−2,644)** — the evening reindex wave reclaimed space. FMV HIGH+MED: nba 7,160→7,181, panini 22,442→22,958 (+516), nfl 1,822→1,829, pinnacle 983→**939 (−44)**, candy 12→16, golazos/ufc 0. editions panini +1,494, candy −5, rest flat.
  - *Pinnacle HIGH+MED −44 is within the ACCEPTED liquidity-ceiling drift class (Declined 2026-09-25: "re-raise only on a step change on a known date"); no step, no failed lane — not flagged.*

## FINDING (new) — `fmv-clamp-disconnected-ask` false-positive stall → RESOLVED 11-22 daytime (`20261122150304`: full-scope runs always log; heartbeat verified 11:38 AM PT, `detect_stalled_pipelines()` clear)
- **What the snapshot shows:** `stalled_pipelines` has one `info` row, classification `no_marker`, silent 4331 min (threshold 4323), last marker 2026-11-19T08:55Z.
- **Reality:** cron **jobid 69** (`55 8 * * *`, daily, active) has **succeeded every day** — `cron.job_run_details` shows `succeeded / "1 row"` on 11-22 08:55Z, 11-21, 11-20, 11-19, … back 10+ days. But the function `fmv_clamp_disconnected_ask(NULL,false)` writes a `pipeline_runs` marker **only once** (a single 11-19 seed row; `rows_14d = 1`). So the `arm_unwatched_pipelines()` watch created 2026-10-26 is pointed at a **marker-less lane** and finally tipped its 3-day threshold tonight — the first night it has appeared.
- **Why QUEUE, not ship:** the pipeline is healthy; the watch is `info`-only and self-documents "info until a human read promotes it," so it will not page. Silencing it is a guard/suppression **claim** change (CLAUDE.md: a suppression is a claim; handle with care) — not a 1 AM autonomous change.
- **Ready paths (operator / daytime / Claude Code):** either (a) have `fmv_clamp_disconnected_ask` write a `pipeline_runs` heartbeat each run (makes the watch meaningful), or (b) add a suppression for this pipeline keyed on "no_marker, cron jobid 69 verified healthy daily." Prefer (a).

## QUEUED
1. ✅ RESOLVED 11-22 ~9:15 AM PT (`20261122170115`, per-wallet background cache; inbox INDEX marked). **`wallet_held_pack_value` 20 s timeout on large pack wallets** — new inbox `2026-11-22T0440Z` (Claude Code evening). 4 PostgREST 500s 02:14–04:32Z, one slow wallet per call (not fan-out contention). **Honest already** — `readHeldPackTotal` counts a failed wallet in `walletsFailed`, never $0, so the cost is a *missing* pack total for whales, not a wrong one. **Not auto-shipped:** the fix is a route-logic/timeout change on the pack-EV path (OFF-LIMITS), and it sits on `get_wallet_pack_history` (v33, 56 KB) reshaped hours earlier = a 24–48 h hot file (collision gate). Filer's three options (owner's call): (1) raise both functions' `statement_timeout` to ~45 s + `READ_BUDGET_MS` to ~46 s (cheapest; slower whale tile); (2) materialise held totals on `fill_portfolio_snapshot_pack_values`, live only as fallback; (3) profile `get_wallet_pack_history(…,'held',1,0)` `tab_totals` on `0xf77bf547fccf6656` (841k buffers/call — the per-row 3× reference cap added in v33 is the newest code on that path).
2. ✅ RESOLVED 11-22 daytime (see FINDING). **`fmv-clamp-disconnected-ask` false-positive stall** — see FINDING. night-count 1.
3. ✅ **TRIAGED 11-22 ~2:20 PM PT (Claude Code cloud, autonomous pass; live evidence per label in [handoff-2026-11-22-daytime-autonomous-pass.md](handoff-2026-11-22-daytime-autonomous-pass.md)) — STOP CARRYING this list.** Closed by measurement: BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE (artifact republished), PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1 (+ the three closed 7:50 AM PT). Parked by design: IPFS ×2. Still open, small: VERCEL cost family (two dashboard settings, Trevor), A1-WORKER-PASSTHROUGH-CLEANUP (optional), refresh-conflated-editions cron (healthy daily since 10-20). Was: **Carried long-standing queue** (unchanged, none re-shipped): SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (weekly-by-design), REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT (Trevor decision), WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1 (gated/CC), Q2/Q5/Q6, N1, IPFS ×2.

4. **Added 11-22 ~12:22 PM PT by the daytime strategy thread (Trevor: "Make sure it survives outside this thread"):** `go-live-2026-09.md` §6 item 5, Top Shot gate **week 2**.
   - On/after **Mon 11-23 ~3:37 AM PT** (job 828), read `fmv_accuracy_weekly` for Top Shot, week_start 2026-11-16, rolled up by confidence (`sum(within_25_pct*n)/sum(n)`).
   - Replace the "provisional 82.8 / 72.9" entry with the final HIGH / MEDIUM numbers. Week 2 counts if both are ≥ 70.
   - Ledger it, push. The Mon 9:40 AM PT falsifier scheduled task (`trig_01G4uTMonfKUQ3zPAxyowj33`, step 5) reports the same line to Trevor.

## Failed / blocked / reverted
None. 0 ships → 0 reverts → no production shipping hard-stop triggered.

## Watches owed next overnight
- `topshot-onchain-art-backfill`: confirm `legacy_resting` / `legacy_rest_until` engaged and run duration dropped (24 h after the 7f4c6e06 deploy).
- `panini-offer-spread`: 24 h median vs 13.4 s — trace `mv_panini_offer_spread` plan only if **sustained** above range.
- `fmv-recalc`: the `:08` deep-historical pass timeout persists by design; not worsening — no action unless the main leg starts failing.
