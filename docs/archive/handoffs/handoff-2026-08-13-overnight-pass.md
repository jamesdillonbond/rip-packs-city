# Overnight pass — 2026-08-13 (OFF-HOURS monitor-mode + NO-PUSH)

> ⚠ **Scope:** the NO-PUSH blocker is specific to **this cloud session** — the workspace shell will not start (`useradd … /sessions no space left on device`), so there is no git clone and no push. **Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl` — commit these output files (metrics-latest.json, this handoff, the ledger entry) as usual.** An environment limitation is a fact about the environment that hit it, not about the artifacts.

## Mode

- **Real time:** DB `now()` = 2026-08-13 14:49Z; app rows bound it (max sale ingest 14:43Z, max FMV 14:49Z) — **no clock skew**. Local = **07:49 PT Thursday Aug 13**.
- **07:49 PT is OUTSIDE 00:00–06:00 → OFF-HOURS MONITOR-MODE:** review + health sweep + post-ship watch, **queue everything, ship nothing** (an auto-revert of a regression would still be allowed — none applicable).
- **NO-PUSH:** shell down → no git. DB migrations *could* apply via MCP but OFF-HOURS says queue, and a migration with no git to commit the parity file would open an uncommittable drift window — so **nothing was written to prod**. Outputs written to the mount.
- Last `metrics-latest.json` was **08-11**; the 08-12 night pass evidently did not write (shell down again). This is ~the 6th consecutive night the shell has blocked the overnight push.

## Health verdict

**Green-with-known-saturation-noise, plus two genuine NEW findings both already caught by the live instruments and both non-shippable from here.** Security clean (`check_public_security_invariants()` = `[]`). Trust-precompute fresh (7.95h vs breach 13) so the trust breaches are real, not a refresher artifact. 0 new Sentry issues in 48h.

### NEW findings (both QUEUED)

**A. `pg_net_http_403` — CRITICAL, 24 edge-fn 403s in 2h — a RECURRENCE.**
This is the gate-key half-rotation outage class. CC fixed it and the arm returned `[]` on **2026-08-12 03:38Z** (`docs/overnight/inbox/2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md`). It is firing `critical` again today. Attribution:
- The 08-11 **real-loss** ingest jobs are **confirmed healthy now** — `allday-pack-opens-forward` (6 runs/3h, last 14:39Z), `ingest-pinnacle-mints-forward/backfill` (18 + 90 runs/3h, last 14:56–14:58Z), `topshot-pack-opens-history-backfill` (12/3h) all writing `pipeline_runs` rows. So the 08-11 pg_cron `?key=` repoint is holding for them.
- Therefore a **different subset** of the 14 gate-keyed jobs (15/16/20/22/25/26/27/29/42/44/55/56/83/84) has re-403'd since 08-12 — exactly the "partial rotation reproduces this outage" the runbook (`2026-08-11T0300Z-gate-key-rotation-runbook.md`) warned of.
- **Cannot attribute the exact jobs from here:** `net._http_response` retains status+body only and cannot be joined back to the request URL (`net.http_request_queue` is pruned on completion). The dispatching pg_cron jobs all show `succeeded` — which measures *dispatch*, not the 403.
- **Fix (operator-owned, OFF-LIMITS to a night pass):** complete the rotation as ONE atomic window — `supabase secrets set` the 8 `*_GATE_KEY` values → deploy the env-var edge fns → repoint the pg_cron `?key=` together. Any subset reproduces this. The `check_edge_fn_http_failures()` arm is doing its job (paging).

**B. `compute-pinnacle-pack-ev` — HIGH, ~100% failure since 08-12 — deterministic, NOT saturation.**
- Error: `upsert pack_distributions: ON CONFLICT DO UPDATE command cannot affect row a second time`. The upsert batch contains ≥2 rows collapsing to the same conflict key within one statement → PG aborts the whole upsert.
- **Regression window (from `pipeline_runs_daily`):** clean 08-04 → 08-10 (all `ok`), first failure **08-11** (2/4), **08-12** 4/4 fail, **08-13** 2/2 fail. Fails identically in the 00:17Z quiet window and the 12:17Z saturated window → deterministic, rules out the disk-IO class.
- **Blast radius:** Pinnacle pack-EV compute aborts → `/disney-pinnacle/packs` EV rows go stale. Bounded to Pinnacle packs; not auth/money/FMV-math.
- **Already the daytime monitor's Candidate 1** (`2026-08-13T1453Z-daytime-monitor.md`) with the same root cause + fix.
- **Fix (CC/operator — pack-EV code + needs edge deploy access, OFF-LIMITS to a night pass):** dedup the batch by the ON CONFLICT key before the upsert (keep last-writer), or split to per-row upserts with the 21000/23505 row-by-row fallback the sales indexers already use. A batch-dedup changes nothing about the EV math — verify byte-identical EV output on a dry run before deploy.

### Trust health — 4 breaches, all known-class
| metric | value | breach | note |
|---|---|---|---|
| `panini_fmv_stale_hours` | 37.4 | 36 | new arm crossing; same root cause as the dry-capture (home-box runner outage); operator |
| `panini_sale_price_capture_dry_days` | 15 | 3 | was 14 on 08-11; +1/day; operator A/B on the box |
| `public_board_slow_count` | 3 | 1 | was 16 on 08-11 — oscillating **down**; snapshots stay fresh via caching, no user impact |
| `unmapped_resolution_backlog_max` | 225 | 100 | AllDay floor; inflow 210/24h vs outflow 223/24h net-draining |

### Other pipeline alerts (all known/carried)
`allday_sales_v1_backfill` cursor stalled ~2d @ block 137390146 (floor); `sync-nba-projections` 100% (NBA offseason, operator); `topshot-active-listings-ingest` 68% egress_blocked (Atlas-WAF, do-not-suppress); `allday-unmapped-resolver-tail` 33% + `wallet-username-resolver` 34% statement timeout (saturation); `unmapped-sales-nfl_all_day` info 47461 (net-draining); `topshot-moments-hydrator` info silent 52min (documented no-op-walk, borderline single read — watch).

### Sentry / Vercel
Sentry: **0** new issues first-seen in 48h. Vercel not polled (nothing shipped; runtime-log full-text search times out under saturation per prior nights — the daytime monitor at 14:53Z reported 0 ERROR-state deploys).

### DB
12,718 MB (was 12,470 on 08-11 — normal 2-day growth).

## Post-ship watch (previous pass — 08-11 night)
- **jobid 259 `rpc-reconcile-saved-wallet-stats`:** now **intermittent** (improved from pure-timeout). Succeeds on quiet ticks (08-13 13:33Z **82.3s** ✓, 08-11 110.8s ✓), fails on saturated ticks (08-12 120.0s timeout, 08-10 300.4s timeout). Known display-only self-healing limitation (soft deadline can't preempt a single long wallet); CC left as-is. **CARRY.**
- **Precompute per-leg split jobid 287 / D34:** healthy — `trust_precompute_max_age_hours` 7.95h. No regression.

## Shipped
**None** — OFF-HOURS MONITOR-MODE + NO-PUSH, and both NEW findings are OFF-LIMITS surfaces (secret rotation / pack-EV code) needing access this pass lacks.

## Auto-reverted
**None.** `compute-pinnacle-pack-ev` regressed ~08-11 but is not auto-revertible from here: no git, no commit attribution without `git log`, and it is pack-EV route logic (OFF-LIMITS). Queued.

## Needs Trevor / Claude Code
1. **Complete the gate-key rotation as one atomic window** — it has recurred (finding A). One subset of the 14 gate-keyed jobs is 403ing again.
2. **Fix `compute-pinnacle-pack-ev`** — dedup the `pack_distributions` upsert batch (finding B) + edge deploy. ~100% failing since 08-12.
3. **Operator provisioning fix for `/sessions` no-space** — the shell has blocked the overnight push for ~6 consecutive nights and the 08-12 pass silently did not write. Delete old Cowork sessions (`docs/handoff-2026-08-09-cowork-shell-recovery.md`).
4. **Drain the 25 un-archived inbox files** — archival is a git mv and there was no git; the two most decisive (08-13T1453Z monitor, 08-12T0330Z 403-resolved) are read and folded above.

## Failed / blocked
- `rpc_ops_snapshot()` timed out (57014) on its `sentinel_fmv_confidence_rows` leg under DB-IO saturation — worked around with individual health functions.
- No git the whole session (shell down). Outputs mirrored to the mount, **unpushed**.
