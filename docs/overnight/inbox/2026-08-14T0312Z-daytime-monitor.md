# Daytime monitor — 2026-08-14T03:12Z (~20:12 PT, 08-13)

Read-only sweep. Bash/git shell down again (`/sessions` no-space, useradd exit 12) → this file written to the MOUNT, push unavailable; night pass picks it up locally. Concurrency lock is RELEASED (stale, 08-11). Inbox is NOT being archived (archival is a `git mv`; shell down) — 31 files standing, expected.

Instance is in a QUIET window this tick — `rpc_ops_snapshot()` returned cleanly (contrast the 00:14Z tick, which timed out inside `sentinel_fmv_confidence_rows`); `trust_precompute_max_age_hours` 2.14 fresh, `fmv_sweep_wedge_hours` 0.19, `public_board_slow_count` down to 1. That quiet baseline is load-bearing for Candidate 1 below.

Health baseline: security CLEAN (invariants / anon_write / rls_off / secdef_drift all `[]`). DB 12,833 MB. Sentinel TS-UUID-editions 48h = 0. Trust breaches 3, ALL known/tracked:
- `panini_sale_price_capture_dry_days` 16 (home-box runner outage; operator/interactive owed).
- `public_board_slow_count` 1 (oscillating saturation collateral; `public_board_empty_count` 0, so no board is broken/empty).
- `unmapped_resolution_backlog_max` 242 (AllDay permanent-class floor; live inflow 65/24h < outflow 88/24h → net-draining, as filed).

`allday-pack-opens-backfill` shows in `detect_stalled_pipelines()` (121 min silent vs 90) but this is the EXPECTED terminal `done:true` state predicted in its own watchlist note (reaches the spork floor ~2026-08-14, today) — job 55 fired 01:06Z/02:00Z fine. NOT a scheduler stop; do not alarm. Retire the watchlist row only if job 55 is unscheduled.

> ⚠ **Follow-up (Claude Code, 2026-08-14 22:40 PT): Candidate 1's verdict holds, but its evidence does not —
> and Candidate 2 is one job, not a subset.** A Vercel-deploy scan cannot detect a **Supabase edge function**
> deploy in either direction; re-measured via the fix's own `dist_dupe_count` telemetry, `bd53bb3a` was
> **never deployed** (not "ineffective"). The `pg_net_http_403` CRITICAL attributes **71/0** to jobid 16
> `rpc-backfill-pack-pool`, needs one secret rather than the one-window rotation, and its blast radius is the
> frozen `gql_historical` pool lane only. See
> [`2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md`](2026-08-15T0540Z-the-403-critical-is-one-job-and-the-pinnacle-deploy-question-is-closed.md).

## Candidates

### 1. [HIGH — correction, do NOT close as resolved] `compute-pinnacle-pack-ev` is STILL 100%-failing; the "bd53bb3a fixed it" claim is false
- **Source:** `pipeline_runs` + `rpc_ops_snapshot().pipeline_alerts`. 8/8 runs failed over 2 days; last error identical `upsert pack_distributions: ON CONFLICT DO UPDATE command cannot affect row a second time`. **Last OK = 2026-08-11 06:17:01Z; only 1 of 12 runs succeeded in 10 days.** Latest failing tick 2026-08-14 00:17:20Z.
- **Why this is a NEW signal, not a re-file of 08-13T1453Z Candidate 1:** CLAUDE.md's 2026-08-13 second docs pass records this as *already fixed* — "compute-pinnacle-pack-ev's deterministic ON CONFLICT self-collision (bd53bb3a)". That is contradicted by the live pipeline: it is still failing identically at the latest tick, and a scan of the last 20 Vercel production deploys (newest tip `dpl_7eKYD1Eb…` commit `9491ec28`, all READY, no ERROR) shows **no pack-EV fix commit** in the window. So the recorded fix either never deployed or was ineffective. **The night pass must NOT mark the queued item resolved on the strength of that docs line.**
- **It is genuinely the deterministic-collision class, re-confirmed:** it failed at 00:17Z inside a QUIET instance window (this tick's `rpc_ops_snapshot` succeeded cleanly, precompute fresh 2.14h), so it is NOT the disk-IO saturation class — it fails identically in quiet and saturated windows, exactly as the 08-13 overnight pass diagnosed. Blast radius bounded: Pinnacle pack-EV surface staleness (`pack_ev_board_max_stale_days` still ok at 0.60, so not yet user-visible, but the writer has been dead 3 days and the board will drift).
- **Suggested action (Claude Code / operator — pack-EV route + edge, not autonomous-shippable):** dedup the batch by conflict key before the `upsert pack_distributions` (keep-last) OR switch to per-row upsert with a 21000/23505 fallback; verify byte-identical EV output before/after. Confirm the fix actually deploys READY and that `pipeline_runs` logs a fresh OK, since the prior "fix" did not.

### 2. [info — already queued, still firing] `pg_net_http_403` CRITICAL recurrence
- **Source:** `rpc_ops_snapshot().pipeline_alerts` — 24 pg_net-dispatched edge-fn calls returned HTTP 403 in the last 2h; sample body `{"error":"forbidden"}`. This is the gate-key half-rotation outage class already queued by the 08-13 overnight pass and runbooked in `inbox/2026-08-11T0300Z-gate-key-rotation-runbook.md`. Not re-filing as new; noting it is still live. Operator: complete the gate-key rotation as ONE window (8 `*_GATE_KEY` secrets + deploy env-var fns + repoint cron `?key=`), per the runbook. `check_edge_fn_http_failures()` will read `[]` once done.

### 3. [info — known saturation-class, single occurrence] `rpc-refresh-misattrib-candidates` pg_cron failure
- **Source:** `check_pgcron_recent_failures()` — 1/1 fail, `2026-08-13 15:35:00Z`, `statement timeout` on `REFRESH MATERIALIZED VIEW public.mv_topshot_misattrib_candidates`. Single occurrence ~11.5h ago during an IO-heavy window; self-heals on the next quiet tick (display-only MV, no user-facing consumer gates on it). Carry as a regression-watch datapoint only; not a fix request.

---

Artifact deep-validation (Section 1b) was NOT run this tick: each active artifact loads via one embedded jsonb payload query in its HTML, and the shell is down so the sandbox-native path is unavailable; rather than Read + replay 11 heavy payloads onto the instance, the schema-coupled backing surfaces were validated indirectly — `rpc_ops_snapshot()` (security/trust/FMV/editions/pipelines) resolved cleanly and `public_board_empty_count` = 0 (no insights board is schema-broken). If a later tick has a working shell, run the per-artifact payloads to confirm.
