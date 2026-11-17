# Plan (NOT applied) — split `rpc_trust_health_precompute_refresh` into per-leg commits

**Register item:** D34 prerequisite. **Status:** reviewable design, nothing shipped. Author: Claude Code, 2026-08-10 (interactive, Trevor said "draft it").

This is the fix for the recurring **12:58Z precompute kills** (three days running: 08-09, 08-10, 08-10 again) that freeze the trust board's precomputed arms — and the standing blocker on adding a Pinnacle FMV-confidence arm (D34). It touches a **load-bearing** object (the sole writer of every precomputed trust-board metric), so it is written as a staged, independently-revertible sequence with verification gates, to be applied only under approval.

---

## 1. The problem, grounded in live measurement (18:58Z tick, 2026-08-10)

`rpc_trust_health_precompute_refresh()` is **one `SECURITY DEFINER` function, one transaction**, `SET statement_timeout='600s'`, writing **18 metric rows** across 7 legs. Per-leg durations from the last successful run:

| leg | metric(s) | measured `duration_ms` | has EXCEPTION handler? |
|---|---|---|---|
| 1 | `topshot_impossible_parallel_serials` | **224,922** | ❌ no |
| 2–5 | 5× `*_fmv_pct_stale_30d` + 5× `*_fmv_high_med_share_pct` | **42,812** | ❌ no |
| 6 | `panini_sale_field_mapping_shortfall`, `panini_sale_price_capture_dry_days` | 1,718 | ❌ no |
| 7 | `sales_serial_supply_worst_pct` | 22,025 | ❌ no |
| 8 | `public_board_empty_count`, `public_board_slow_count` (the liveness probe) | **85,841** | ✅ yes |
| 9 | `pack_ev_publish_shortfall_pct` | 8,914 | ✅ yes |
| 10 | `fmv_sanity_flags` | 18,539 | ✅ yes |

Sum ≈ **405 s on a healthy tick.** Under disk-IO saturation the same legs balloon and the run exceeds its **600 s** cap. Because it is one transaction, **a kill on any leg rolls back every metric already computed** — including the cheap ones that finished in milliseconds. That is exactly what froze the board-liveness arms at the 06:58Z snapshot while the 12:58Z tick died (documented in `docs/overnight/inbox/2026-08-10T1700Z-*.md`).

Two structural consequences:

- **The instrument goes dark precisely when it matters.** The precompute only dies when the instance is saturated — which is exactly when boards are genuinely slow — so `public_board_slow_count` freezes at its last good value right when it should be rising. `trust_precompute_max_age_hours` (breach 13h) is the only thing that currently notices, and only after 13h.
- **4 of 7 legs have no per-leg exception handler**, so their failure mode today is "roll back all 18", not "mark my own metric 999". The 3 that do (legs 8/9/10) already degrade honestly to 999.

**Only caller:** pg_cron jobid 222 (`58 */6 * * *`, `SELECT public.rpc_trust_health_precompute_refresh();`). **No** route, no TS/TSX file, no other DB object calls it (verified 2026-08-10). The function's **RETURN jsonb is read by nobody** — it lands only in `cron.job_run_details.return_message`. So the only contract that must be preserved is: *the same 18 metric rows keep landing in `public.rpc_trust_health_precompute`* (read by `v_rpc_trust_health`'s `pre` CTE). The metric names, the table, and the reader are all unchanged by this plan.

---

## 2. The fix: per-leg SECDEF functions + a thin INVOKER orchestrator procedure that COMMITs between legs

This is the **exact pattern proven in prod today** on `reconcile_all_saved_wallet_stats` (migration `20260810…`, the saved-wallet reconcile). A procedure can do transaction control (`COMMIT`); a function cannot. After each leg commits, a later leg's timeout can no longer roll it back.

```
                        ┌─ leg_1_fn()  SECDEF, SET statement_timeout, EXCEPTION→999 ─┐
 pg_cron (as postgres)  │  ...                                                        │  each writes its own
   CALL orchestrator()  ┤  leg_8_fn()  (board liveness)                               ├─ metric row(s) via
   (single statement)   │  ...                                                        │  INSERT … ON CONFLICT
                        └─ leg_10_fn() (fmv sanity)                                    ┘
                              ▲ orchestrator PERFORMs each, COMMIT after each ▲
```

### 2.1 Why the budget lives on the leg FUNCTIONS, not the procedure — the three hard constraints (all learned in prod this session)

1. **The orchestrator must be INVOKER-rights, carry NO `SET` clause, and be called as a single statement.** A `SECURITY DEFINER` procedure OR a `SET` clause on it puts the call in an atomic context, and then `COMMIT` fails `2D000 invalid transaction termination`. The cron command must be a bare `CALL …` — a `SET …; CALL …` prefix is itself an implicit transaction block and COMMITs will 2D000. (All three failure modes measured with throwaway pg_cron probes on 08-10.) The orchestrator therefore **schema-qualifies every reference** instead of using a `SET search_path`, and a runtime `SET search_path` is rejected because it would persist on the pooled connection after the call returns.

2. **`statement_timeout` does NOT re-arm per `COMMIT`.** Only the timer armed at top-level statement start counts, so you cannot give the whole `CALL` a "600s that resets each leg" budget. The per-leg budget must therefore live where it re-arms naturally: as a **`SET statement_timeout` clause on each leg FUNCTION** (functions don't COMMIT, so a `SET` clause is legal and correct there). The orchestrator's own statements (the `PERFORM` dispatch, the `COMMIT`s) are trivial and complete in milliseconds.

3. **`postgres` has no role-level `statement_timeout`** (verified: `rolconfig` = search_path only). The ~120s cap the D8 handoff measured for pg_cron is the **cluster default**. Each leg function's `SET statement_timeout='<leg budget>'` clause **overrides that default locally** for the leg's duration — which is exactly how the current monolith already buys its 600s. Nothing between legs needs more than the default (COMMIT + dispatch are instant).

### 2.2 Each leg function catches its own timeout → a slow leg becomes a LOUD breach, not a silent rollback

Every leg function wraps its heavy read in `BEGIN … EXCEPTION WHEN OTHERS THEN <write 999> END`. A statement timeout raises `57014 query_canceled`, caught by `WHEN OTHERS`; the handler then writes the arm's **999 sentinel** (already the established "unavailable → breach" convention on legs 8/9/10). So a leg that genuinely can't finish inside its budget flips its OWN arm red and lets every other leg commit — strictly better than today's all-or-nothing rollback. The 999-writing INSERT re-arms a fresh timer with the full leg budget, so a trivial insert never itself times out.

### 2.3 Privilege

- Leg functions stay **`SECURITY DEFINER`** (they read cross-schema and write `rpc_trust_health_precompute`). Each gets `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` (Supabase's default grant is to PUBLIC — a `FROM PUBLIC` revoke is required, not just anon/authenticated; verify with `has_function_privilege('anon', …, 'EXECUTE')`, not the ACL text). `postgres` (owner) + `service_role` keep implicit grants.
- The orchestrator is **INVOKER**, but pg_cron runs it as `postgres`, and it only calls SECDEF leg functions (which run as their definer) — so no privilege is lost by the invoker downgrade. `REVOKE` it from PUBLIC/anon/authenticated too.
- `check_public_security_invariants()` and `check_secdef_anon_exec_drift()` must read `[]` after each migration (a new SECDEF fn that is anon-executable would trip the drift check).

### 2.4 Leg budgets — GENEROUS, because the value is the COMMIT, not a tight cap

The point of the split is **durable partial progress**, not aggressive per-leg killing. A budget set *below* a leg's honest cost converts a survivable slow-tick into a **false 999 breach** — the opposite of the goal. So each budget is set well above the measured healthy duration with saturation headroom:

| leg | measured | proposed `statement_timeout` | rationale |
|---|---|---|---|
| panini (6) | 1.7s | `60s` | trivial; cap only guards a pathological hang |
| pack_ev (9) | 8.9s | `120s` | already has a handler; keep generous |
| fmv_sanity (10) | 18.5s | `180s` | view read; saturation multiplies it |
| serial_supply (7) | 22s | `180s` | partition scan |
| fmv_coverage (2–5) | 42.8s | `240s` | the 10-metric latest-per-edition scan |
| board_liveness (8) | 85.8s | `300s` | the probe already self-bounds per-board; this is a backstop |
| impossible_parallel (1) | **225s** | `300s` | ⚠ see §5 — this leg is itself a latent problem |

There is intentionally **no whole-run 600s cap** anymore. With per-leg commits and per-leg self-bounds, the run simply takes as long as it takes and commits as it goes; only a leg that blows its generous individual budget writes 999. This removes the single failure mode that has bitten three times.

**Ordering: cheapest-first** (panini → pack_ev → fmv_sanity → serial_supply → fmv_coverage → board_liveness → impossible_parallel), so on any bad tick the maximum number of arms have already committed fresh values before the expensive tail runs. This is a strict improvement over today's order (impossible_parallel FIRST, so its 225s is the first thing a kill throws away).

---

## 3. Staged, independently-revertible rollout

Each migration is inert until the next one wires it in, so any stage can be verified (or reverted) before proceeding. **No stage changes the metric names, the table, or the reader**, so `v_rpc_trust_health` and every `/api/sentinel` consumer are untouched throughout.

### M1 — create the 7 leg functions (byte-faithful extraction; adds handlers to the 4 that lack one)

`CREATE OR REPLACE FUNCTION public.rpc_thp_leg_<name>() RETURNS void SECURITY DEFINER SET statement_timeout='<budget>' SET search_path='public','pg_temp' AS $$ … $$;`

Each body is the **verbatim** SELECT + `INSERT … ON CONFLICT (metric) DO UPDATE` from the current monolith for that leg, wrapped in a `BEGIN … EXCEPTION WHEN OTHERS THEN <insert 999 for this leg's metric(s)> END`. Legs 8/9/10 already have the handler — lift them unchanged. **Nothing calls these yet**, so M1 is a pure no-op addition. `REVOKE` grants on each. Verify: `check_secdef_anon_exec_drift()` = `[]`.

> The fmv_coverage leg (2–5) writes 10 metrics from one scan — keep it as ONE function (splitting the scan would 2× the cost). The panini leg writes 2 from one scan — same. The 999 handler for a multi-metric leg writes 999 to **all** of that leg's metrics.

### M2 — create the orchestrator procedure

```sql
CREATE OR REPLACE PROCEDURE public.rpc_trust_health_precompute_refresh_p()
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.rpc_thp_leg_panini();          COMMIT;
  PERFORM public.rpc_thp_leg_pack_ev();         COMMIT;
  PERFORM public.rpc_thp_leg_fmv_sanity();      COMMIT;
  PERFORM public.rpc_thp_leg_serial_supply();   COMMIT;
  PERFORM public.rpc_thp_leg_fmv_coverage();    COMMIT;
  PERFORM public.rpc_thp_leg_board_liveness();  COMMIT;
  PERFORM public.rpc_thp_leg_impossible_parallel(); COMMIT;
END;
$$;
REVOKE EXECUTE ON PROCEDURE public.rpc_trust_health_precompute_refresh_p() FROM PUBLIC, anon, authenticated;
```

**No `SECURITY DEFINER`, no `SET` clause, every reference schema-qualified** — per §2.1. Still nothing schedules it. Optional pre-cutover smoke: a throwaway one-minute pg_cron job that `CALL`s it once, confirm it commits and returns cleanly (this is how the 2D000 constraints were validated this session), then unschedule.

### M3 — cut the cron over

```sql
SELECT cron.unschedule(222);              -- old monolith job
SELECT cron.schedule('rpc-trust-health-precompute-refresh', '58 */6 * * *',
  $$CALL public.rpc_trust_health_precompute_refresh_p()$$);
```

Single-statement `CALL` — no `SET` prefix (§2.1). The old **function stays defined** (unscheduled) so revert is a one-line reschedule. Keep the same `58 */6` slot.

---

## 4. Verification & rollback

**After M3, at the next 58-past tick:**
- All 18 metrics in `rpc_trust_health_precompute` share a fresh `computed_at` (≤ a few min old), each with a plausible `duration_ms`.
- `trust_precompute_max_age_hours` resets toward 0.
- Trust board still shows **38 arms**; `v_rpc_trust_health` unchanged; `check_public_security_invariants()` = `[]`.
- **The real test is a saturated tick:** on the next 12:58Z-class kill, confirm the cheap legs kept fresh values (their `computed_at` advanced) while only the leg that ran out of budget shows 999 — i.e. no more all-or-nothing rollback.

**Rollback (any stage):**
- M3: `SELECT cron.unschedule(<new jobid>); SELECT cron.schedule('rpc-trust-health-precompute-refresh','58 */6 * * *',$$SELECT public.rpc_trust_health_precompute_refresh();$$);`
- M2: `DROP PROCEDURE public.rpc_trust_health_precompute_refresh_p();`
- M1: `DROP FUNCTION public.rpc_thp_leg_<name>();` ×7.
- The monolith function is never dropped by this plan, so a full revert is just the M3 reschedule.

---

## 5. What this UNBLOCKS, and what it does NOT fix

**Unblocks D34.** Once each leg is its own committed function, a **Pinnacle FMV-confidence-share leg** (reading `pinnacle_fmv_history`, its own table) can be added as an 8th leg function + one `PERFORM … COMMIT;` line — with its own budget and its own 999 handler, unable to roll back any other arm. That is the exact safety property D34 was blocked on ("no existing leg to piggyback on, and adding a new scan to the monolith risks all 18").

**Does NOT fix — flagged as separate follow-ups, do not fold in:**
- ⚠ **Leg 1 (`topshot_impossible_parallel_serials`) costs 225s to return a structurally-near-zero count.** It is `editions JOIN sales WHERE serial_number > circulation_count` over TopShot. Splitting makes it survivable but not cheap; budget raised 300s→**480s** in M3a (it runs LAST/most-contended in the cheapest-first order, so 300s was only 1.33× headroom over its healthy cost → false-999 risk). **§5 CHARACTERIZED 2026-08-11 (EXPLAIN, not run — ANALYZE would cost 225s):** the plan is already index-optimal — a Nested Loop that, for each of ~2,001 TS parallel editions (`external_id ~ '::'`), probes ALL 8 `sales_YYYY` partitions' `edition_id` indexes (~16,000 cross-partition probes) and **heap-fetches every matching sale** to evaluate `s.serial_number > e.circulation_count`, because no existing sales index carries `serial_number` (they are `(edition_id, price_usd)` / `(edition_id, sold_at)`). Under disk-IO saturation that heap-fetch storm is the whole 225s; planner cost 183,188. **Not a cheap autonomous fix — the two real levers are both gated:** (a) a covering index `sales_*(edition_id, serial_number)` on all 8 partitions to make the serial test index-only — **CONCURRENTLY, operator/quiet-window, and adds write cost on hot partitions the indexers write constantly** (the INCLUDE-blocks-HOT tradeoff); or (b) restrict the scan to a recent `ingested_at` window (mirroring Leg 7 serial-supply) — far cheaper since old sales are immutable and the write-guards `update_topshot_sale_serial`/`update_sale_serial` already validate serials at write, so an impossible serial can only arrive via a guard-bypassing bulk backfill — **but this is a SEMANTIC change to a health arm (all-time → recent-window), an owner decision** (it stops permanently-reporting an old accepted case, which is arguably better, but changes what the arm means). Interim 480s budget holds.
- ⚠ **The board-liveness probe still times `count(*)`**, which the planner can prune (the separate HIGH item in `…T1900Z-*.md`). This plan makes the probe's staleness impossible-to-inherit, but does not fix the count(*) pruning — that is a distinct change with estate-wide arm-flipping consequences and must be shipped deliberately on its own.
- The **underlying board slowness** (`allday_scarcity_board`, `topshot_first_mint_trophy_stats`) is the standing materialize-latest-FMV item — orthogonal.

## 6. Risks / do-not

- **Do not** make the orchestrator `SECURITY DEFINER` or give it a `SET` clause (→ 2D000). **Do not** prefix the cron `CALL` with `SET`.
- **Do not** set a per-leg budget below the leg's saturated cost — that manufactures a false 999. Prefer over-generous budgets; the COMMIT is the isolation mechanism, not the timeout.
- **Do not** drop the monolith function until the split has survived several saturated ticks.
- Verify `check_secdef_anon_exec_drift()` = `[]` after M1 and M2 (new SECDEF objects default to a PUBLIC EXECUTE grant).
- Ship M1/M2/M3 as **separate migrations with separate pushes**, verifying between — this is a load-bearing writer and the whole point is to de-risk it, not to land it in one big diff.
