# Overnight pass — 2026-10-21 (~01:15 AM PT)

> ✅ **Correction 2026-10-21 ~6:40 AM PT (Cowork cloud):** Queued #3 (DROP 3 leftover scratch tables) is already done — dropped 10-20 7:37 AM PT by one-off pg_cron 761 (ledger 10-20 "DROPPED (3 scratch tables)"); re-read live: 0 `scratch_*` / `zz_probe*` relations in `public`. Queued #1 shipped 10-21 3:04 AM PT as `20261021100313`. Only #2 (#58, Trevor) remains.

**Verdict: GREEN · 0 production shipped · idle: routed-to-claude-code · oldest routed: #58 OPENSEA_API_KEY ~26 nights (Trevor).**

> ⚠ **3+ nights routed:** #58 OPENSEA_API_KEY has sat ~26 nights (Trevor-only; `candy_sales_stale` now 220.8h). Not idle — it has a queue and a single owner (Trevor), see below.

Git push was AVAILABLE this pass (device-VM clone + `.rpc-git-cred`, dry-run exit 0). Mode: cloud nightly, DB + handoff/metrics/session committed via the VM clone. No code or migration shipped — not because of push, but because nothing was clearly-safe-and-non-hot (see below).

## What was reviewed

- **Inbox drained through INDEX.md + since-last-pass filings.** Four filings dated after the 10-20 08:16Z pass, all already drained/explained by the daytime monitor:
  - `2026-10-21T0015Z` + `2026-10-21T0315Z` item 1 — **refresh-conflated-editions** 120s maxDuration kill writes no terminal `pipeline_runs` row. The daytime pass shipped the 120s→300s fix (`4392d28`, 10-20 12:22 PM PT); confirmed `maxDuration = 300` in the repo. Verifies on the next tick (10-21 08:17 AM PT / 15:17Z) — a terminal `ok=true` row should land and `detect_stalled_pipelines()` should drop it. **Carried as a watch, not re-shipped.**
  - `2026-10-20T2110Z` + `0315Z` item 2 — **topshot_missing_fill_offers_walk cursor +9.4M jump** (158.9M→168.3M, 10-19 18:12Z). Explained: the ASCENT of the 10-19 morning dispatch from the 130,290,659 weekly re-seed, sampled mid-climb (focus 10-19 steer). Not a regression. No action.
  - `2026-10-20T1509Z` — **allday-v1-reverify lane (pg_cron 762) first ticks**: 12/12 ok on 10-20; first real V1-reverify dispatch due ~10-27 (dated check in #198). No action.
  - `0315Z` items 3 (dashboard sources) + 4 (metrics baseline stale): item 3 is not true of origin/main (the 11 ported dashboard sources ARE committed under `docs/cowork-skills/`, #114 carries the 11 artifact links — the monitor read a pre-`ff35959` tree); **item 4 (refresh the 3-day-stale metrics baseline) is this pass's duty — DONE below.**
- **Dashboards:** none flagged broken/stale by the monitor; not individually re-validated this pass (data is fresh-on-open). The daytime 0315Z sweep validated the 3 committed-source dashboards clean.
- **Post-ship watch — the 10-20 Claude Code sweep (~30 commits, six live sweeps).** GREEN. `public_board_empty_count` 0, `public_board_slow_count` 0, `fmv_sanity_flags` 0, `pinnacle_fmv_impossible_flags` 0, `pack_ev_board_pct_depleted` 0, all `*_fmv_stale_hours` ≤0.5. Vercel 24h: 7 error groups, all count 1–5, single-user, degrading gracefully — NO new error class attributable to the sweep (two transient Cloudflare 502s on edition sub-reads degraded to empty via the honesty helpers; benign). FMV accuracy backtest intact (below). Nothing reverted.

## Health-drift findings + deltas

Fast baseline `rpc_ops_snapshot()` @ 08:09Z. **GREEN except the known #58 candy breach.**

- **Security:** clean (invariants/anon_write/rls_off/secdef_anon all `[]`); independently confirmed by direct catalog SQL — 0 RLS-off public base tables, 0 anon/authenticated write holes.
- **Trust health:** 37/38 ok; `trust_precompute_max_age_hours` 5.35 (breach 13) so the arms are trustworthy. Only breach: `candy_sales_stale_hours` **220.8** (breach 168) = #58 (196.8 on 10-20; climbing by design while the Candy market is frozen since 10-11). `fmv_sweep_wedge_hours` 0.02 (10-17 fix holding).
- **`check_when_others_timeout_blind()` = 1 → `autograph_sweep_tick` (R118).** NEW surface this pass. See Queued #1.
- **`check_zero_yield_lanes()` = 5 offenders, all explainable, none a regression:** candy-sales-indexer (#58 frozen), topshot-set-series-onchain (no new series; `currentSeries=8`), resolve-topshot-stubs + topshot-stub-resolver (backlog drained, last_find 10-13), allday-unmapped-resolver-tail (#160 drained 10-11).
- **Stalled:** refresh-conflated-editions only (known; fix in repo). **Cursor rewinds:** the explained missing-fill ascent only. **Sentinel TS-UUID 48h:** 0. **wmc_null / search_path_drift / cross-collection staleness / suppression drift:** all `[]`.
- **pipeline_fails_24h:** topshot-pack-supply-atlas 249 (chronic 403-retry, upstream 0), atlas-market-feed 17, sync-nba-projections 6 (muted to 10-28), rest ≤3; all upstream 0.
- **FMV accuracy (R125, 7d):** Top Shot published ALL median_ratio **1.000** (err 15.0%, HIGH within-25 83.2%); All Day published ALL **1.071** (err 21.7%, median_abs_err_usd $0.05 — 93% of sales sub-$1; HIGH within-25 80.3%). Both inside [0.90, 1.10] — tracking the market, no drift.
- **Client-error beacon:** 0 / 24h (0 prior 24h). **Sentry:** dark (#34), not a health signal.
- **Deltas vs 10-20:** db +274 MB (40,440→40,714, normal). FMV HIGH+MED: nba 6,443→6,489 (+46); panini 14,064→**15,797** (+1,733 coverage); nfl 1,690→1,674 (−16); pinnacle 922→945 (+23); candy 67→70 (+3, MEDIUM draining by design); golazos 0→1; ufc 0. editions: panini +427, others flat. Trust breaches 1→1.

## Shipped

None to production. The only doc writes are this handoff, `metrics-latest.json` (refreshed — it was 3 days stale per inbox item 4), and the session-log entry. No code, no migration: the entire code tree is collision-hot from the 10-20 sweep (every surface file has a <48h commit), and the one new DB finding is in a hot, owner-iterated, off-limits-adjacent area (Queued #1).

## Queued for Trevor / Claude Code

1. **[P3, Claude Code, 1 night] `autograph_sweep_tick` trips `check_when_others_timeout_blind()` (R118).** The per-item `WHEN OTHERS` handler inside the drain loop does not carry a `WHEN query_canceled` arm, so the detector flags it as blind to a 57014 kill. **It is the intentional per-item case:** the handler sits inside the loop (`LOOP` 944 < `EXCEPTION` 3898 < `END LOOP` 4232 in `prosrc`) recording per-page parse/write errors and continuing, and the author's own comment reads *"caught 57014 would run on with the timer disarmed; a kill must end the run (the tick's next run retries)."* So the R118-correct disposition is to **register `autograph_sweep_tick` in the detector's exclusion list with the loop argument** (per the check's own guidance for a per-item-loop handler), NOT to change the handler. Owner-area: autographs shipped 10-19 ~8 PM PT (`20261020030228`, pinned `supabase/tests/autograph_sweep_tick.sql`) and is still being iterated (last autograph commit `2ca8130df`, 10-21 02:42Z). Zero live harm (beacon 0, no autograph-sweep failure in `pipeline_fails_24h`, autographs board validated clean by the daytime pass). Night pass did not ship it: hot file + instrument change + judgment call belongs to the owner. **No revert needed (not shipped).**
2. **[P2, Trevor, ~26 nights] #58 `OPENSEA_API_KEY`.** `candy_sales_stale_hours` breaching at 220.8h; the Candy indexer is healthy (8/8 ok) but Magic Eden's Candy feed has been silent since 10-11 and OpenSea is unkeyed. Clears when Trevor sets the key or the Magic Eden feed resumes. Do not re-tune the arm (10-19 steer).
3. **[P3, Trevor/interactive, carried] DROP 3 leftover scratch tables (~4.8 MB)** — `public.scratch_20261019_counter_checks_before`, `scratch_20261010_rip_dist_sample`, `scratch_20261010_rip_ident_batches`. All RLS-on, no anon exposure; cosmetic. Off-limits DROP for a night pass; needs the SQL editor.

## Carried watches (no decision needed)

- **refresh-conflated-editions** 300s fix — verify on the 10-21 08:17 AM PT tick (terminal `ok=true` row; `detect_stalled_pipelines()` drops it). If still `invoked_but_never_logged` after that tick, the 300s raise was insufficient — chunk the conflation work or move the terminal `log_pipeline_run` before the slow leg.
- **Dated checks:** demand re-read due ≥10-22; #193 Pinnacle re-measure due ≥10-31 (pricing-engine change → NOT a night-pass ship; report numbers only).
- **Candy FMV MEDIUM** steps down by design (10-19 steer) while no Candy sale is indexed — exits week of 11-02 and 11-09, ~0% by ~11-11. Falsifier: a HIGH/MEDIUM Candy edition whose newest sale is >30d old after a recalc.

## Failed / blocked / reverted

None. No verification failure; no hard-stop. Push available; no collision (origin/main steady at `0a7d4515` across the pass).
