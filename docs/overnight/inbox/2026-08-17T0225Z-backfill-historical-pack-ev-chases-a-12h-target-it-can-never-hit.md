# ⚠ QUEUED: `backfill-historical-pack-ev` chases a 12h freshness target it can never hit — and only 48h is required

Cowork cloud, 2026-08-17 ~02:25Z / 2026-08-16 19:25 PT. Measured live. **Nothing shipped.**

> ⚠ NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push
> normally. **Commit files as usual.**

## The measurement

`rpc-backfill-historical-pack-ev` (`13 * * * *`, hourly) runs
`backfill_topshot_historical_pack_ev(15)`. It is the **second-largest worker-time consumer**:
**5,224 worker-seconds/24 h** over 24 runs, **2,412 s of it on 4 failed runs**, max **611 s** — i.e.
it is hitting a ceiling.

⛔ **Despite the name, it is NOT a finite backfill.** Its candidate exclusion is:

```sql
AND NOT EXISTS (SELECT 1 FROM pack_ev_history h
                WHERE h.collection_id = d.collection_id AND h.dist_id = d.dist_id
                  AND h.snapshotted_at > now() - interval '12 hours'
                  AND COALESCE(h.edition_count, 0) > 0)
```

Every dist becomes a candidate again after **12 hours**. It is a recurring refresh and **can never
saturate** — the opposite of jobid 215, which is why the cadence lever that worked there would make
this one *worse*.

| | |
|---|---|
| eligible TopShot dists (uuid + priced + multi-tier drop pool) | **596** |
| refreshes required by its own 12 h window | **1,192 / day** |
| capacity at `p_limit=15` × 24 runs | **360 / day** |
| **achieved share of its own target** | **~30%** |

Per-item cost ≈ **14.5 s** (5,224 s ÷ 360 items). **Actually meeting the 12 h target would cost
~17,280 worker-seconds/day — more than jobid 215 was burning before tonight's cut.** The target is
not affordable on this instance at the current per-item cost.

## ⛔ The point: nothing actually requires 12 hours

| arm | value | breach_at | status |
|---|---|---|---|
| `pack_ev_board_max_stale_days` | **0.907 d (21.8 h)** | **2 d (48 h)** | ok |
| `pack_ev_publish_shortfall_pct` | 0.80 | 10 | ok |
| `pack_ev_board_pct_depleted` | 0 | 30 | ok |

The function's internal window is **4× stricter than the arm that gates it**. And the observed
staleness of 21.8 h is exactly what a job delivering 30% of a 12 h target produces — comfortably
inside the 48 h requirement.

**So the outcome is already correct. What is wrong is the cost of getting there:** the job runs a
permanently-full candidate set forever, burns 5,224 worker-s/day, and dies at its ceiling on 1 run in
6 — and per the worker-slot-squat mechanism, each of those deaths holds a background-worker slot for
its full duration having written nothing, which is what produces `job startup timeout` on other jobs.

## Recommended lever (NOT shipped — this is a data-freshness decision, not a cost tweak)

**Relax the function's internal window from `12 hours` to ~`36 hours`.** Then:

- required throughput falls **1,192 → ~397/day**, just above its 360/day capacity, so the candidate
  set stops being permanently full;
- runs stop presenting a saturated candidate set and should stop hitting the 611 s ceiling;
- staleness stays well under the **48 h** breach — the arm that actually governs.

⚠ **Why I did not ship this.** It is a `CREATE OR REPLACE FUNCTION`, not a schedule change, and it
directly moves a **monitored freshness target**. Relaxing a freshness window is exactly the class of
change that *looks* like a cost saving and is really a data-quality decision — and the honest reading
is that **this job is not failing at its purpose**: the board is fresh enough today. The waste is
real; the outcome is fine. That combination belongs on Trevor's desk, not in an autonomous ship.

⚠ **Alternative worth pricing first:** the cost is inside
`compute_pack_ev_per_edition_weighted(...)` at ~14.5 s per dist. If that can be made materially
cheaper, the 12 h target becomes affordable and no freshness decision is needed at all. I have **not**
measured that function — naming it as the unmeasured alternative rather than implying the window is
the only option.

## ⚠ Do not "fix" this by cutting cadence

Jobid 215 was saturated, so halving its cadence reclaimed pure waste. **This job is starved, not
saturated.** Cutting its cadence reduces an already-insufficient 30% further and pushes staleness
toward the 48 h breach. **The two jobs sit at opposite ends of the same diagnostic and take opposite
levers — check which one you are looking at before touching a schedule.**
