# The `:13` pg_cron collision is OPERATOR-ONLY — which is why it keeps being re-diagnosed and never fixed

Filed 2026-08-16 ~09:30 PT (16:30Z) by the monthly deep audit (run 2, continuation).

## What was observed live

At **16:13 UTC** (three minutes before measurement) the instance held **11 long-running queries and
8 `DataFileRead` waiters**. Three `cron_heavy` backends had started in the same second, all blocked
on **`DataFileWrite`**:

| backend | age |
|---|---|
| `SELECT public.backfill_topshot_historical_pack_ev(15)` | 160 s |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv` | 160 s |
| `SELECT public.refresh_topshot_special_serial_owners_mv();` | 160 s |

Stacked behind them were **eight `authenticator` (PostgREST, i.e. user-facing) queries at 26–85 s**,
all on `DataFileWrite` or `BtreePage` — `candy_scarcity_board`, `candy_special_serials_board`,
`candy_parallel_premium`, `topshot_first_mint_trophy_stats` ×2. **The public insights boards are
collateral damage from a cron collision**, which is exactly the mechanism CLAUDE.md records as the
saturation root cause, caught in the act.

## The collision, named

| jobid | name | schedule | owner | 7d runs | avg | max |
|---|---|---|---|---|---|---|
| **71** | `rpc-backfill-historical-pack-ev` | `13 * * * *` | `cron_heavy` | 167 (155 ok / **12 fail**) | **150 s** | **611 s** |
| **109** | `rpc-refresh-special-serial-owners-mv` | `13 4,16 * * *` | `cron_heavy` | 14 (14 ok) | 89 s | 225 s |

`cron.timezone` is **GMT**, so 109's `4,16` really is 04:13 / 16:13 UTC and it lands squarely on 71's
hourly minute **twice a day**. The episode above was one of those two.

⚠ **jobid 71 is the standing load, not 109** — hourly, 150 s average, 611 s worst, and 12 failures in
7 days. Staggering 109 removes 2 collisions/day; it does **not** address the hourly cost.

⚠ **Do NOT retire jobid 71 on a "backfills finish" hunch.** Checked before proposing it:
`pack_ev_history` is written **~2,100 rows/day across ~830 dists**, steadily, through 08-16. It is
doing real work. (Caveat: that table has several writers, so this does not attribute all of it to 71
— but it is enough to refuse a retirement.) This is the `pinnacle-sales-history-backfill` near-miss
shape and the answer is the same: don't.

## ⛔ THE ACTUAL BLOCKER, and it is the point of this filing

**The fix cannot be applied from the Supabase MCP.** Measured:

```
current_user = postgres · rolsuper = false · pg_has_role(postgres,'cron_heavy','MEMBER') = true

cron.alter_job(109, schedule => '43 4,16 * * *')
  → ERROR XX000: Job 109 does not exist or you don't own it     -- as postgres
SET ROLE cron_heavy; cron.alter_job(...)
  → ERROR 42501: permission denied for function alter_job        -- as cron_heavy
```

`cron.alter_job` checks ownership **literally**, not by role membership, so being a MEMBER of
`cron_heavy` is not enough — and `cron_heavy` itself lacks EXECUTE on the function.

**Job ownership splits cleanly, and it maps onto exactly the wrong half:**

| owner | active jobs | alterable from MCP? |
|---|---|---|
| `postgres` | **50** | ✅ yes — this is why the 2026-08-14 `cron.alter_job(302, …)` worked |
| `cron_heavy` | **42** | ❌ no |

**The `cron_heavy` set is where the heavy jobs live — including 71 and 109.** So the jobs that cause
the saturation are precisely the set that cannot be rescheduled by any autonomous session. That is
the reason this collision has been identified repeatedly and never fixed: **every session that found
it had no way to act on it, and the write-ups recorded the finding without recording the blocker.**

## What an operator needs to run

```sql
-- as a superuser / the cron_heavy owner
SELECT cron.alter_job(109, schedule => '43 4,16 * * *');
```

Minute **43** verified free of any other `cron_heavy` job, and 30 minutes clear of jobid 71 (whose
611 s worst case reaches ~:23). **Revert:** `SELECT cron.alter_job(109, schedule => '13 4,16 * * *');`

**Better durable fix:** grant EXECUTE on `cron.alter_job` to `postgres` for the `cron_heavy`-owned
set, or move scheduling of the heavy jobs under `postgres`. Otherwise the next session to find this
will also be unable to fix it, and will file it again.

## Verified clean in passing — a useful negative result

The 2026-08-16 trust-precompute split (jobids **324–331**) puts six jobs on minute **48** and two on
minute **9**, which *looks* like a new collision cluster. It is not: each is hour-separated
(`48 0,6,12,18` · `48 1,7,13,19` · `48 2,8,14,20` · `48 3,9,15,21` · `48 4,10,16,22` ·
`48 5,11,17,23`), so **exactly one leg runs per hour**, as that split's design note claims. No action.

## Third backend still unattributed

`REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv` ran as `cron_heavy`
at the same instant, but **no `cron.job` row carries that command** (searched by command text and by
jobname across all schedules). It is presumably issued from inside another function. Worth resolving
before the stagger, since it may need moving too — a stagger that leaves two of three colliding buys
less than it appears.
