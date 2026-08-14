# Two schedulers run the same wmc FMV propagation, and they lock each other out

Filed 2026-08-14 (Claude Code, interactive). **Read-only. Nothing shipped** —
the fix is "remove one caller", which is an ownership decision about FMV
propagation, and FMV is off-limits for autonomous shipping.

Found while blocked on something else: the DB has been sustained-saturated on
**DataFileWrite** for ~2h across repeated checks, which is what is holding the
`get_pack_detail_bundle` item (`inbox/2026-08-14T1830Z-…`) out of its quiet
window. This is a large part of why.

## The two callers

| | pg_cron **jobid 303** | the route |
|---|---|---|
| what | `SELECT public.refresh_wmc_fmv_changed(30, 200000)` | `/api/wmc-fmv-populate` → `runRefresh("refresh_wmc_fmv_changed", { p_since_minutes: 30, p_limit: 50000 })` |
| schedule | `7-57/10 * * * *` (**every 10 min**) | external cron-job.org (**~every 5 min**; not in `vercel.json`) |
| row budget | **200,000** | 50,000 |
| statement timeout | long (`cron_heavy`) | ~30 s |
| observed duration | **364 s, 379 s** (live `pg_stat_activity`) | ≤ 34.9 s (it is killed) |
| logs to `pipeline_runs`? | **NO** | yes (since `cd1018f0`) |

Same function, same 30-minute window, same rows. Neither knows about the other.

## The damage, from `pipeline_runs`

```
refresh_wmc_fmv_changed        343 runs  229 ok  114 fail   (33.2% failing)
refresh_wmc_fmv_drift_active   341 runs  255 ok   86 fail   (25.2% failing)
```

Failure breakdown across both (200 total):

| error | n | duration range |
|---|---|---|
| `canceling statement due to statement timeout` | **108** | 30.2–34.5 s |
| `canceling statement due to lock timeout` | **92** | 8.3–27.5 s |

⚠ **The 92 lock timeouts are the direct evidence.** A lock timeout is not
generic slowness — it is *another writer holding the rows this one wants*. The
only other writer of these rows on this cadence is the pg_cron job doing the
identical work with a 4× larger budget. They are not merely overlapping; they
are blocking each other.

⚠ **And the heavier caller is invisible to the very logging added to make this
observable.** `cd1018f0` (2026-08-12) gave these RPCs `pipeline_runs` rows
precisely because they had been failing `57014` on every tick for 10+ hours with
no DB-visible signal. But that logging lives in the ROUTE. jobid 303 is a raw
`SELECT` and writes nothing — proven by the numbers above: the logged max is
**34.9 s** while the live job was observed at **364 s** and **379 s**. So the
fix made the *cheap, failing* caller visible and left the *expensive, succeeding*
one dark.

**Nothing alerts on any of this.** A third of propagation ticks have been dying
since 2026-08-13 16:08 (when the logging began) and the signal has sat unread.

## Recommendation

**Remove one caller.** They are redundant by construction — same function, same
`p_since_minutes: 30`.

Preferred: **drop the route's call, keep jobid 303.** The pg_cron version
actually completes (it has the budget and the timeout for it) and covers 4× the
volume; the route's copy fails a third of the time and is the one taking lock
timeouts. The toggle already exists — the route supports **`?skip_refresh=true`**
— so this is a cron-job.org URL change, not a code change.

⚠ If instead the route is kept, jobid 303 must be unscheduled *and* the route's
budget/timeout raised to match, or propagation silently regresses to whatever
fits in 30 s.

⚠ **Whichever is kept must log to `pipeline_runs`.** Keeping jobid 303 as-is
re-creates the exact blind spot `cd1018f0` was written to close.

## Why not shipped

- FMV propagation is explicitly off-limits for autonomous shipping, and this is
  a question of which scheduler *owns* it — a judgment, not a defect fix.
- Both levers are prod-state and neither is a code change: a pg_cron schedule,
  or an operator-only cron-job.org URL.

## ⚠ Method note — one of my own readings was wrong

My first pass reported "2 concurrent instances, overlap confirmed live" from
`pg_stat_activity where query like '%refresh_wmc_fmv_changed%'`. **One of the
two was my own query**, which matched because its text contains the function
name. Filter out `application_name = 'mgmt-api'` (or the current `pid`) before
counting. The overlap conclusion survives — but it rests on the 92 lock timeouts
and the 364 s/34.9 s duration split, which are real evidence, not on that count.
