# The `:13` pg_cron collision — ✅ FIXED 2026-08-16, and the "operator-only" premise in this title was WRONG

Filed 2026-08-16 ~09:30 PT (16:30Z) by the monthly deep audit (run 2, continuation).

> **✅ STATUS: SHIPPED ~09:45 PT. jobid 109 → 332, moved `13 4,16` → `43 4,16`, still `cron_heavy`-owned.**
> **⛔ THE TITLE AND THE "ACTUAL BLOCKER" SECTION BELOW ARE WRONG AND ARE KEPT AS THE LESSON.** I hit
> two permission errors, concluded the class was operator-only, and wrote it up that way — while jobs
> **324–331 had been created as `cron_heavy` hours earlier**, which was standing proof a path existed.
> **Two failed verbs are not a closed door; enumerate the permission surface before declaring a blocker.**
> The working path was one query away: `cron_heavy` HAS `schedule` + `unschedule`, just not `alter_job`.
>
> ```sql
> SET ROLE cron_heavy;
> SELECT cron.unschedule(109);
> SELECT cron.schedule('rpc-refresh-special-serial-owners-mv', '43 4,16 * * *',
>                      'SELECT public.refresh_topshot_special_serial_owners_mv();');
> ```
>
> ⚠ **RESCHEDULE AS `cron_heavy`, NEVER AS `postgres`** — `cron.schedule` stamps `username = current_user`,
> and `cron_heavy` carries `statement_timeout=600s` while `postgres` inherits the global **120s**. This
> job's measured max is **225 s**, so a `postgres`-owned copy would start silently timing out. The
> ownership is a *budget*, not bookkeeping.
>
> ⚠ `unschedule`+`schedule` mints a NEW jobid (109 → **332**); anything citing 109 is now stale.
> **Revert:** `SET ROLE cron_heavy; SELECT cron.unschedule(332); SELECT cron.schedule('rpc-refresh-special-serial-owners-mv','13 4,16 * * *','SELECT public.refresh_topshot_special_serial_owners_mv();');`

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

## ✅ Third backend RESOLVED — it was the SAME job, and the name is why nobody saw it

`REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv` carries no
`cron.job` row because **it is the second statement inside `refresh_topshot_special_serial_owners_mv()`**
— the function jobid 109/332 calls. Read from `pg_get_functiondef`, its body is:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_special_serial_owners_mv;
REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv;
```

⚠ **A function named `..._topshot_...` refreshes the AllDay MV too** — which is exactly why a search
by command text and by jobname found nothing, and why this read as a mystery third scheduler. Its own
`log_pipeline_run` call says so (`'mvs', 'topshot+allday'`); the NAME does not. **Same lesson as the
`_p` procedure trap already in CLAUDE.md: read the body, never infer the callee from the name.**

**So the stagger moves TWO of the three colliding backends, not one of three** — the correction runs
in the reassuring direction, and the "may need moving too" worry is void. Nothing further to move.

## ⚠ BUT THE STAGGER IS NOT THE LEVER FOR THE 225 s RUN — and the arithmetic says so cleanly

Both of this job's daily ticks collide with jobid 71, because **71 is hourly**. So that collision is
present in both ticks equally — and the ticks are not equal:

| date | 04:13Z (21:13 PT) | 16:13Z (09:13 PT) | ratio |
|---|---|---|---|
| 08-13 | — | 138.2 s | — |
| 08-14 | 16.4 s | 159.9 s | **9.8x** |
| 08-15 | 37.6 s | 181.5 s | **4.8x** |
| 08-16 | 22.5 s | **224.8 s** | **10.0x** |

**A cause present in both ticks cannot explain a 10x difference between them.** The dominant cost is
**ambient concurrent load** — 04:13Z is quiet, 16:13Z is the business-hours peak — not the `:13`
collision. And `:43` at 16:43Z is still business hours. So the stagger is worth keeping (it removes a
real collision and costs nothing), but **do not expect it to fix the 225 s run**, and do not read a
still-slow 16:43Z tick as the stagger having failed.

⚠ **The 16:xx tick is also TRENDING UP — 138 -> 160 -> 181 -> 225 s over four days** — which tracks
the platform-wide saturation this file's opening section observed, not anything about this job.

## ⚠ Live confirmation that a function-level `statement_timeout` is INERT

`refresh_topshot_special_serial_owners_mv()` declares **`SET statement_timeout TO '200s'`** in its
`proconfig`. The 08-16 16:13Z run took **224.8 s and reported `ok: true`.** Had that declaration bound
the statements inside the function, the run would have been cancelled at 200 s.

**It did not, so it does not.** The binding budget is the caller's role — `cron_heavy`'s 600 s. This
is an independent second instance of the trap already recorded for the drain seeders and the
trust-precompute legs, found on a function nobody had looked at, and it is further evidence that any
fix phrased as "raise the function's declared timeout" is a no-op.

⚠ **Corollary for reading this pipeline: `pipeline_runs.duration_ms` is a hard 0 on every row.**
`log_pipeline_run` is called with `p_started_at => clock_timestamp()` while `finished_at` defaults to
**`now()`, which is transaction-stable** — so the generated column measures the transaction, not the
work. **Read `extra->>'duration_ms'`** (computed with `clock_timestamp()`), which is where every
figure in the table above comes from.
