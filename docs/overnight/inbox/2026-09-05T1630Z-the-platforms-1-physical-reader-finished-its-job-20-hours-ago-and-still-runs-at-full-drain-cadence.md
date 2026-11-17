# The platform's #1 physical reader finished its job 20 hours ago and is still running at full drain cadence

**Filed 2026-09-05 09:30 PT (16:30Z), Claude Code (Trevor's box, interactive). MEASUREMENT ONLY — NOTHING CHANGED, deliberately (see §5).**

`reconcile_wmc_metadata_from_editions` — pg_cron **jobid 456**, `rpc-wmc-metadata-reconcile`, `*/10 * * * *` — is now the **largest consumer of physical reads on this database**, and its corrective work has been done since **2026-09-04 ~21:00Z**.

⚠ This is a **cadence** observation, not a defect report. The function is correct, chunked, deadline-bounded, and did exactly what it was built to do. **The finding is that the schedule was sized for a drain that has finished.**

---

## 1. It converged, and the convergence is unmistakable

`rows_written` per hour, from its first run:

| window | rows written |
|---|---:|
| 09-04 14:00–20:00 (first ~7 h) | 92,020 · 49,495 · 146,804 · 122,719 · 68,704 · 95,413 · 59,285 = **634,440** |
| 09-04 21:00 → 09-05 16:00 (~20 h) | 632 · 87 · 60 · 314 · 178 · 58 · 81 · 130 · 173 · 84 · 7 · 279 · 6 · 5 · 200 · 67 · 59 · 69 · 70 · 2 = **2,561** |

**99.6% of every row it has ever written landed in the first seven hours.** Lifetime total 637,001 across 119 runs, which ties out exactly (634,440 + 2,561 = 637,001).

⭐ **The scan volume did not follow.** `rows_found` is pinned at **exactly 1,200 per run** across all 119 runs — the chunk size — before and after convergence. **The write rate fell ~1,000×; the read cost did not move at all.**

ⓘ `wmc_metadata_reconcile_state` reads `cycles: 6` — it has wrapped the whole population **six times**. So it is **not a backfill that finishes**; it is a permanent recurring full sweep, and it re-walks everything roughly every 4.3 h forever.

## 2. What it costs now that it is done

`ops_pgss_delta('12 hours')`, `counter_reset = false`, a window entirely after convergence:

| | |
|---|---:|
| calls | 74 |
| **physical reads** | **4,266,051** |
| physical reads per call | **57,649** |
| DB time | **1,980 s** (33 min) |
| rows written in the same window | **~1,151** |

👉 **≈ 3,700 physical reads per row written.** Extrapolated to 24 h that is **~8.3M physical reads and ~66 minutes of DB time**, which makes it **#1 on the platform** — ahead of `query_sql`/fmv-recalc at 6,798,496 (inbox `2026-09-05T1626Z`).

🚨 **Why this matters more than the raw number: this instance is IO-bound, not CPU-bound** (SMALL tier, 22 MB/s burst floor). Physical reads are the scarce resource, and the single largest consumer of it is a sweep whose corrective work ended a day ago.

## 3. The honest counter-argument, stated because it is a real one

⛔ **A low write rate is the POINT of a reconciler after its drain.** It exists to catch *new* drift — truncated and placeholder set names arriving with new data — that the NULL-only fill path can never touch. Writing ~128 rows/hour is it working, not it failing, and **"retire it" would be the wrong conclusion.**

👉 **So the question is proportionality, not existence:** is a **10-minute** cadence the right price for a drift rate of ~128 rows/hour, when each tick costs ~57,600 physical reads on the binding constraint? At `*/60` it would still catch the same drift within an hour and would cut roughly **83% of ~8.3M reads/day**, dropping it out of the top ten readers entirely. **That trade is the decision; the numbers above are what it should be decided on.**

⚠ **Not established, and worth knowing before changing anything:** whether the drift arrives in bursts tied to an ingest tick. If it does, a slower sweep lengthens the window in which a user can see a truncated set name, and the right answer may be *event-triggered* rather than *less frequent*. The hourly write series above (`632 · 87 · 60 · 314 · 178 …`) is too flat to settle that either way.

## 4. Related, from the same sweep of the delta

- `query_sql` (fmv-recalc) fell **12,125,016 → 6,798,496** physical reads/24 h and is now **#2**. Its attribution still passes its own falsifier — inbox `2026-09-05T1626Z`.
- The `[edition]` statement timeouts are **contention, not cost** — same filing. `get_edition_market_bundle` is 94.4% cache-served and 11th by physical reads.

## 5. ⛔ Why nothing was changed

1. **It is another session's work from 2026-09-04**, inside the 24–48 h window the collision rule says not to edit.
2. **It is a cadence decision for its owner**, who has context on the drift rate I do not.
3. Changing a pg_cron schedule is reachable from here, which is exactly why the restraint is worth recording rather than assumed.

## 6. Falsifiers

1. **If `rows_written` climbs back into the thousands per hour**, the drift rate is higher than measured, the cadence is justified, and §3's trade is wrong. Re-run the hourly series before acting.
2. **If `reconcile_wmc_metadata_from_editions` is NOT #1 by `d_shared_blks_read` over 24 h**, this filing is stale — the ranking moves as other jobs change.
3. **If `cycles` stops advancing** while runs continue, the sweep has wedged and this becomes a different (worse) finding.

⚠ Every figure is a dated sample on a load-varying instance. Re-derive before quoting.
