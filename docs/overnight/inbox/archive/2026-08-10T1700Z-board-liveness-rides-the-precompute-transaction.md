# Finding — `public_board_slow_count` is reporting a 10-hour-old sweep as if it were current

Cowork cloud session, 2026-08-10 ~09:55 PT. **Read-only; nothing applied.** Found while verifying the
five migrations that landed from the interactive side between 15:43Z and 16:42Z.

---

## ⛔ CORRECTION (Claude Code, 2026-08-10 ~11:15 PT) — THE ALARM IS **REAL**. Do not act on §"The alarm is false".

**The staleness mechanism below is CONFIRMED. The conclusion drawn from it is REFUTED.** Re-measured
live with `EXPLAIN (ANALYZE)` — which reports true execution time — not with a wall-clock harness:

| board | budget | snapshot | **live now (EXPLAIN ANALYZE)** | verdict |
|---|---|---|---|---|
| `allday_scarcity_board` | 8,300 | 41,686 | **32,809 ms cold / 38,574 ms warm** | **REAL — 395–465%** |
| `topshot_first_mint_trophy_stats` | 5,400 | 6,587 | **17,308 ms** | **REAL — 320%, worse than snapshot** |

Both are **genuinely, structurally over budget**, and both are **WORSE now than the stale snapshot** —
the opposite of the "contention artifact" reading. The warm re-run being *slower* than the cold one
rules out cold-cache as the explanation.

**Why the 4,044 ms figure was wrong.** It came from timing `SELECT count(*)` by wall clock. I
reproduced that method (`clock_timestamp()` around a `MATERIALIZED` CTE) and it returned **0 ms** for
the same 6,190-row board — an impossible result: the planner evaluates the timestamps independently of
the counted CTE, so the harness measures nothing. **Do not time a board this way; use `EXPLAIN ANALYZE`.**

**Root cause of the slowness (the actual fix target).** `allday_scarcity_board` runs a **Nested Loop
with 6,190 loops**, each a per-edition latest-FMV probe into partitioned `fmv_snapshots`
(~5.2 ms × 6,190 ≈ 32 s; 2,942–2,988 heap fetches). This is the **same "latest FMV per edition"
shape already documented for `/api/market` and `cross_collection_deals_board`** — the standing
precompute/materialize item, not a new problem. `topshot_first_mint_trophy_stats` is a different
shape: a **Parallel Seq Scan over `sales_2026`** (330,582 rows × 2 workers, 144,180 removed by filter)
for its 180-day `serial_number > 1` aggregate, with no supporting index.

**Two further corrections to the analysis below:**

- ⚠ **"It does not use the existing 999 sentinel" is FALSE.** The board arms are precomputed rows in
  `rpc_trust_health_precompute`, and `v_rpc_trust_health`'s `pre` CTE **already maps any row with
  `computed_at < now() - 24h` to 999.** The guard exists; it is set at 24 h and the snapshot is 11.2 h
  old, so it simply has not tripped. Proposed fix #2 is therefore a **tightening of an existing guard
  from 24 h to ~8 h**, not the addition of a missing one — a smaller, better-understood change.
- ⚠ **`trust_precompute_max_age_hours` (breach 13) already fires EARLIER than that 999 mapping**, so
  precompute staleness is already attributable at 13 h. Live now: **11.18 → 11.21 and climbing**
  (was 9.98 when this was filed), confirming the 12:58Z tick never recovered.

**NEW, missed by the sweep below: 2 orphaned state rows.** `public_board_liveness_state` holds **47**
rows against **45** active watchlist entries. `candy_deals_board` and `topshot_underpriced_serials_board`
are `is_active = false` but their state rows were never deleted, so they are frozen at
**2026-08-02 01:40Z — 208 h (8.7 days) stale.** They do **not** inflate the count (the probe derives
`n_slow` from its own loop over active rows, not from the table), so this is cosmetic — but it makes
the state table actively misleading to read by hand. Worth a cleanup, not an alert.

ⓘ The 06:58Z sweep was **not** budget-truncated: it probed 45 of 45 active boards. The probe already
has both a budget-exhaustion `EXIT` and a per-probe `statement_timeout`, so it does degrade by design.

**Revised recommendation:** fixes #1 and #2 below remain worth doing (the staleness mechanism is real),
but they are **honesty plumbing, not the priority**. The priority is that **two public boards are
genuinely 3–5× over budget right now** and need the FMV-materialization / index work.

---

## ~~The alarm is false, and the reason is structural~~ — SUPERSEDED, see correction above

`public_board_slow_count` read **1** last night and reads **5** now. **It is not a regression.**

| board | snapshot `elapsed_ms` | budget | snapshot % | live now |
|---|---|---|---|---|
| `allday_scarcity_board` | **41,686** | 8,300 | **502%** | **4,044 ms → 49%** ✅ |
| `topshot_first_mint_trophies` | 11,451 | 6,200 | 185% | — |
| `topshot_first_mint_trophy_stats` | 6,587 | 5,400 | 122% | — |
| `candy_special_serials_board` | 5,169 | 4,100 | 126% | — |
| `cross_collection_deals_board` | 15,410 | 15,400 | 100% | — |

**All five carry the identical `checked_at` — `2026-08-10 06:58:00Z`.** I re-measured the worst one
live (`SELECT count(*)`, the same thing the probe times): **4,044 ms for 6,190 rows, 49% of budget.**
The 41.7 s figure is a contention artifact of one sweep, ten hours stale.

## Why it is stale — the probe is a passenger on another job's transaction

- `public_board_liveness_probe(integer)` has **exactly one caller in the entire database**:
  `rpc_trust_health_precompute_refresh()`. No pg_cron job calls it, no Vercel cron route calls it, no
  TS/TSX file references it.
- That job — **jobid 222, `58 */6 * * *`** — **failed at 12:58Z on a 600.0 s kill**. It also failed
  at 12:58Z on **08-09**, same 600.0 s. Two consecutive days, same tick.
- The function is a single transaction with no handler on the failing leg, so **the kill rolled back
  the probe's writes along with everything else** — the documented all-or-nothing behaviour.
- Result: `public_board_liveness_state` is frozen at the **06:58Z** sweep, which itself ran inside a
  278.3 s precompute run, i.e. **already under load**.

## Why this is worse than an ordinary stale metric

⚠ **The arm does not degrade honestly.** It does not error, and it does not use the existing **999**
sentinel that already means *"the sweep budget was exhausted."* It keeps serving the last successful
sweep **as if it were a current measurement**, with nothing in the arm indicating its age.

⚠ **And the blindness is correlated with the thing being measured.** The probe only runs inside the
precompute, and the precompute only dies when the instance is saturated — which is exactly when
boards would genuinely be slow. **The instrument goes dark precisely when it matters**, the same
shape already recorded for `health_check()` timing out under saturation.

⚠ **This is a NEW instance of the class.** The recorded caveats on these arms are *"`=0` does not
mean healthy (the probe times `count(*)`, which the planner prunes)"* and *"999 means the sweep
budget was exhausted."* **Neither covers "the snapshot can be arbitrarily old because it rides another
job's transaction."**

ⓘ **Self-correction:** my own 08-09d handoff reported `public_board_slow_count = 1` and named
`topshot_first_mint_trophy_stats` as the breaching board. That reading was **also** a snapshot
(`checked_at` 00:58Z, ~2 h old at the time). The conclusion happened to be right; the method was the
same one that produced today's false alarm.

## What the system *did* get right

`trust_precompute_max_age_hours` — the arm added on 08-09 for exactly this failure — reads
**9.98 / 13, ok**. It is tracking correctly and would breach at ~19:58Z **if the 18:58Z tick also
fails**. So staleness is detectable; it is just not attributed to the board arms that are actually
lying. 👉 **Watch the 18:58Z tick.**

## Fixes — neither shipped

1. **Root cause: split the precompute.** This was already the standing recommendation. It is now
   stronger for two reasons: there is a **second** distinct victim (the board arms, not just the 18
   metrics), and the mechanism is no longer hypothetical — the **per-item `COMMIT` procedure pattern
   was proven in prod today** on `reconcile_all_saved_wallet_stats`. A liveness leg that commits
   independently survives a later leg's kill. **Prefer one procedure with per-leg commits over seven
   cron entries** — same isolation, one object, one schedule.
2. **Cheap honesty guard (independent of 1).** Map the board arms to the existing **999** sentinel
   when `public_board_liveness_state.checked_at` is older than ~8 h, so staleness is visible *in the
   arm* instead of being silently inherited. ⚠ This edits `v_rpc_trust_health` — 38 arms,
   load-bearing; assert on the arm anchor, keep the count at 38, and re-assert
   `security_invoker = on` plus `check_public_security_invariants()` after.

⛔ **Do not "fix" this by re-tuning any board's `max_ms`.** ~~Four of the five have no demonstrated
problem at all; the one I measured is at **49%** of its budget live.~~ **REASONING SUPERSEDED — the
directive still holds, but for the OPPOSITE reason.** Two of the five are confirmed 3–5× over budget
by `EXPLAIN ANALYZE` (see correction at top). Do not raise `max_ms`, because that would **silence a
true positive** — the budgets are correct and the boards need to be made faster.

## Other verification from the same sweep — all clean

- **No active cron job references a missing function or procedure** — checked all 81 after
  `…_wmc_selfheal_unschedule_and_drop_proc_d8` dropped one and `…_wmc_selfheal_recent_fn_d8`
  created another. No orphaned scheduler entry.
- `check_public_security_invariants()` `[]` · `check_secdef_anon_exec_drift()` `[]` · trust board
  **38 arms** · **81 active jobs**.
- Other breaches unchanged and known: `panini_sale_price_capture_dry_days` 13 (browser-harvest item,
  operator-side), `unmapped_resolution_backlog_max` 194 (retry-queue depth, not backlog).
