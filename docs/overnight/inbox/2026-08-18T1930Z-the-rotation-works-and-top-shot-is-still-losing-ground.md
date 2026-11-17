# The rotation works — and Top Shot is still losing ground. The one unverified inference is refuted.

**Filed 2026-08-18T1930Z (12:30 PT) · Cowork cloud · READ-ONLY · post-ship watch on `21ab85ef`**

The `21ab85ef` filing stated plainly that *"the Top Shot tail draining is an inference from those, not
something I watched."* ⛔ **Watched now, and it is not draining.**

| collection | before (`21ab85ef`) | first tick | now (12:20 PT) | direction |
|---|---|---|---|---|
| `nfl_all_day` | 33,861 | 32,861 | **30,922** | ✅ draining, ~2,900 cleared |
| `nba_top_shot` | 452,789 | — | **454,316** | ⛔ **UP 1,527** |

## ✅ The fix is real — All Day proves it

All Day has fallen **33,861 → 30,922** across the window, continuing past the single tick that was
originally measured. The rotation reaches it, the scoped call writes, the outcome table moves. **The
starved-backfill diagnosis and the `cron.alter_job` fix are both confirmed on the outcome table, not
on the self-report.**

## ⛔ But Top Shot is a FLOW, not a STOCK

It received ticks in the same window — the 36.6 s / 47.9 s / 64.4 s runs at 12:12, 12:02 and 11:42 PT
are the long ones, and Top Shot is the expensive collection — **and the backlog still rose by 1,527.**

**So new `wallet_moments_cache` rows arrive with `fmv_confidence IS NULL` faster than Top Shot's share
of the rotation can clear them.** Golazos (6), UFC (499) and All Day (33,861) are finite backlogs that
a rotation drains. Top Shot is not; it is a steady-state inflow, and a 1-in-4 rotation share is below
its arrival rate.

⚠ **The rate is INFERRED, the direction is MEASURED.** With ~1,000 rows/tick and roughly a quarter of
12 ticks/hour, Top Shot's drain capacity is ~3,000/hr; net +1,527 over ~50 min implies inflow near
~5,000/hr, so it loses ~2,400/hr. **Every term in that except the two counts is an assumption** —
tick share, rows per tick, and the exact interval since the prior read. **Do not quote the rate.** Two
counts of the same predicate an hour apart would settle it cheaply.

## What this does and does not change

- ⛔ **Do NOT revert `21ab85ef`.** It fixed a real starvation and All Day demonstrates it.
- ⚠ **"The backlog will drain" is not true for Top Shot under the current share.** If the goal is to
  clear the 454k, rotation alone will not get there — it needs a larger share, a larger `p_limit` for
  that collection specifically, or the inflow understood first.
- 💡 **The prior question is whether the inflow is legitimate.** 454k NULL-confidence rows that keep
  arriving may mean the writer that populates `wallet_moments_cache` is not setting confidence at
  insert, in which case the backfill is permanently chasing a producer. **That is a cheaper thing to
  check than a bigger drain**, and it is not checked here.

## Load context — the reading conditions differed from the last measurement

`pg_stat_activity` at 12:17 PT: **5 of 46 backends in IO wait, 7 active.** The `21ab85ef` session
measured 13 of 37. ⚠ **The spell had eased, which is why the Top Shot count completed here and timed
out there — that is a difference in conditions, not a difference in method.** A grouped
`join collections` variant still timed out at 60 s; the per-collection `collection_id = <uuid>` form
against the index is the one that returns.

⚠ Also observed: the **11:27 PT tick ran 370.3 s and swallowed the 11:32 slot** — ticks resume at
11:37. Consistent with the reaping-lag reading already filed; noted because it means a long tick costs
a rotation slot, which lowers the effective share further.

**No changes made.** Read-only; no DB, migration, cron or code change.
