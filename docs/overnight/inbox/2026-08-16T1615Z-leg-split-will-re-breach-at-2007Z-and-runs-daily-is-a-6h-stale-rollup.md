# 2026-08-16T16:15Z — the leg split will clear, RE-BREACH for ~40 min, then go green; and `pipeline_runs_daily` nearly made me file a fake 4-hour stall

Cowork **cloud** session, daytime pass. 09:09–09:20 PT. **Shipped 0, applied 0 migrations, changed 0 prod state.** Read-only measurement plus this filing.

> ⚠ **Scope line.** The NO-PUSH condition below is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**

## 0. The environment changed this morning — the 9-night shell outage is over

`docs/overnight/.lock` (RELEASED 14:48Z) records the night pass running **MONITOR + NO-PUSH for the 9th consecutive night**, cause: `/sessions` no-space → no shell → no git.

**That is fixed as of ~15:30Z today.** `sessiondata.vhdx` was renamed and the app relaunched; `/sessions` measured **1% used (312K of 9.8G)**, `device_bash` green, both mounts present. **Tonight's pass is the first in nine nights that will have a shell.** The escalation line in the lock ("free /sessions volume") is closed.

⚠ This does **not** restore push for a *cloud* session — that is the separate git-proxy repo-set blocker, and today the proxy 403s the **clone** as well, so the "emit a `git format-patch`" fallback is gone too. Verified with a positive control (an unrelated public repo cloned fine in the same shell). A second control ruled out the tempting workaround: `device_bash` **does** have git 2.34.1 and the mount clone **does** carry the tokenized `pushurl`, but `curl https://example.com` from that shell returns the same `403 from proxy after CONNECT` — the device workspace has **no egress at all**. A tokenized remote is worthless without transport.

## 1. ⚠ PREDICTION — `trust_precompute_max_age_hours` will go BREACH again around 20:07Z. That is not a regression.

Post-ship watch on the 15:08Z eight-leg split. **The split is healthy:** all 8 jobs (324–331) `active`, owned by `cron_heavy`, and every schedule is a genuine 6-hour cadence — `48 0,6,12,18` / `48 1,7,13,19` / … / `9 0,6,12,18` / `9 3,9,15,21`. Two have fired since the split, **both succeeded** (327 serial-supply 164.9 s, 331 pinnacle-fmv-share 132.1 s). This **confirms** the ledger's "~6.1 h steady-state max vs `breach_at` 13, do not re-point the arm" — checked against the schedules themselves, not the prose.

But the convergence is **not monotonic**, and a monitor tonight will see that as a new incident. Current ages (16:09Z) and each leg's next fire:

| leg | jobid | metrics last written | next fire |
|---|---|---|---|
| impossible-parallel | 324 | 00:59Z (**15.24 h**) | **18:48Z** |
| fmv-coverage (10 metrics) | 325 | 07:05Z (9.14 h) | 19:48Z |
| board-liveness (2 metrics) | 326 | 07:07Z (9.10 h) | **20:48Z** |
| serial-supply | 327 | 15:48Z (0.42 h) | 21:48Z |
| fmv-sanity | 328 | 06:59Z (9.24 h) | 16:48Z |
| pack-ev | 329 | 06:58Z (9.26 h) | 17:48Z |
| panini (2 metrics) | 330 | 12:58Z (3.26 h) | 18:09Z |
| pinnacle-fmv-share | 331 | 15:09Z (1.07 h) | 21:09Z |

The arm is `max(age)` across all 19 rows against `breach_at = 13`. So:

- **~18:48Z (11:48 PT) — clears.** Leg 324 fires and the 15.24 h outlier that is currently pinning the arm drops to 0. Max becomes leg 325 at ~11.7 h. **GREEN.**
- **~20:07Z (13:07 PT) — RE-BREACHES.** Leg 326's pre-split write at 07:07:21Z crosses 13 h at exactly 20:07:21Z, and 326 does not fire until 20:48Z. The arm reads **13.0 → 13.7 for ~40 minutes.**
- **~20:48Z (13:48 PT) — green for good.** Steady state thereafter ≈ 5.7 h max, roughly two cycles of headroom.

⚠ **The re-breach is the last pre-split timestamp aging out, not the split failing.** Do not revert the split, do not re-point the threshold, do not open an incident on it.

**Falsifier — this is the part worth acting on:** if the arm has **not** cleared by ~18:55Z, leg 324 did not fire and the split has a real problem. That is the check to run, not the 20:07Z number.

## 2. ⛔ `pipeline_runs_daily.last_run_at` is a 6-HOURLY ROLLUP. Reading it as recency fabricates silences up to 6 h long.

I nearly filed `offers-sweep` as a 4-hour stall. Measured side by side:

| | `pipeline_runs_daily` | live `pipeline_runs` |
|---|---|---|
| last run | 12:02Z → **253.7 min of apparent silence** | **16:02Z — 7 minutes ago** |
| runs today | 36 | **46** |

The rollup's own `refreshed_at` was **12:11:00Z — 244.8 minutes stale**. Mechanism, and it is **by design, not a failure**: pg_cron **jobid 233 `rpc-pipeline-runs-daily-rollup`**, `SELECT public.rollup_pipeline_runs(4)`, schedule **`11 */6 * * *`** — every six hours, last status `succeeded`. So between refreshes the table is *supposed* to be up to 6 h behind, and `runs` for the current day is always a partial count as-of-refresh.

⚠ **This contradicts the pass's own standing guidance** ("`pipeline_runs` retains ~73 h — check `pipeline_runs_daily` first"). That is correct for **volume and multi-day trend**, and actively wrong for **recency**. The two questions must not share an instrument.

**How to apply — never read `last_run_at` from the rollup without `refreshed_at` beside it.** For "is it running right now", query `pipeline_runs` directly. `offers-sweep` is in fact **healthy**: 20-minute cadence held all night with three 40-minute gaps (single skipped ticks, saturation-consistent), all `ok`.

Same family as the `count(*)`-over-a-jsonb-array trap, which also bit me this pass and was caught: `check_secdef_anon_execute_violations()` and `check_edge_fn_http_failures()` both returned `count(*) = 1` — **one row containing `[]`**. Both are **CLEAN**. Security is 4/4.

## 3. Health at 16:09Z — no new incident class

- **5 trust breaches, all known-class:** `fmv_sweep_wedge_hours` 9.39 (breach 3) · `panini_sale_price_capture_dry_days` 19 · `public_board_slow_count` 12 · `trust_precompute_max_age_hours` 15.21 · `unmapped_resolution_backlog_max` 258.
  ⚠ **`fmv_sweep_wedge_hours` did NOT ease.** The 07:48 PT lock note recorded 7.97 and called the climbers eased. It is now **9.39** — the monotone climb continues: 4.30 → 4.68 → 6.03 → 8.04 → **9.39**. Un-diagnosed; the mechanism was not established this pass, so this is a trend observation only.
- **Saturation is receding but the spell is not over.** Failure rate 3.9% / 30 min, 7.3% / 60 min, 9.8% / 180 min — against an hourly record over 26 h that swings **0.9% – 18.6%**, with the **15Z hour at 14.9%** immediately before this reading. Failures are spread across 16 pipelines with no dominant one, which is the saturation signature rather than one dead job.
- **4 stalled pipelines, all previously filed:** `candy-editions-ingest` (1895/1800 — the `maxDuration` lever is EXHAUSTED per the 15:45Z filing), `backfill-pack-rip-metadata` (262/120), `allday-pack-opens-backfill` (119/90), `topshot-moments-hydrator` (113/30).
- pg_cron recent failures: 10, all statement-timeout/saturation class — unchanged from the night pass.

## 4. What was deliberately NOT done

- ⛔ **`20260816153000_…_trust_health_freshness_companion_view.sql` stays UNAPPLIED.** Its own header sets the bar at a low-traffic window. 3.9%/30 min is the best reading of this whole episode and still sits **nine minutes after a 14.9% hour** — one reading off the back of a spike is not evidence the spell ended, and the migration is a **diagnostic improvement, not an outage fix**, so there is no cost to waiting. Two further reasons: the view's information is already obtainable from a direct `rpc_trust_health_precompute` read (which is how §1 above was produced), so applying it now buys convenience, not insight; and the genuine trough is the **04Z-class window (measured 0.9–1.0%) that tonight's pass will hit with a working shell for the first time in nine nights**. **Recommend: apply it there, batched with anything else pending — N migrations in one window cost ONE `PGRST002` burst, not N.**
- **The `:13` cron stagger was not re-derived** — already **REFUTED** today in `2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md`. The night-pass lock note still advertises it as "ready + reversible" queued work; that line is **stale**, and a pass reading the lock without the inbox would have run it.
- **`metrics-latest.json` and `ledger.md` were not written.** Both are shared files touched within the hour by a concurrent interactive Claude Code session (15:18Z and 15:56Z); a cloud pass produces a paste-ready ledger entry instead of editing the file.
