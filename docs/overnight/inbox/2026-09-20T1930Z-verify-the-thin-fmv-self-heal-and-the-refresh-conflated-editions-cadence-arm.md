# Verify the thin-FMV self-heal, and the cadence arm that is dormant until 09-21 17:30 PT

**Filed:** 2026-09-20 ~12:3x PM PT (Claude Code cloud). **Two dated checks, both cheap, both landing
after the filing session ended.** Nothing here needs a code change unless a check fails.

## Why this exists

`topshot_thin_fmv_editions` — the deal board's "thin data" caveat set, which alerts also suppress on —
was measured **57.9 hours stale** on 2026-09-20 (7 rows, every one stamped 09-18 01:30 PT) with **both**
of its writers failing and **four instruments blind** to it. Full account: ledger 2026-09-20 and
`docs/reference/cron-and-schedulers.md` ("Four instruments, zero coverage").

The staleness itself was cleared by hand at **11:41:52 AM PT** (11 rows). ⚠ **That is a one-off, not a
fix** — these two checks are what establish the lane looks after itself again.

## Check 1 — did both writers recover on their own schedules? (due 2026-09-21 morning PT)

Re-measured on the Large tier the same day, read-only, the function's SELECT half took **11.23 s** and
flagged **11** editions — against `canceling statement due to statement timeout` at **601 s / 604 s** on
09-19 and 09-20. So both writers should now finish comfortably:

- **pg_cron job 63** `rpc-refresh-thin-fmv-guard`, `30 8 * * *` — needs ~11 s of a 600 s ceiling.
- **`/api/cron/refresh-conflated-editions`**, daily 08:17 PT — needs ~11 s of a 120 s Vercel wall.

```sql
-- expect: a row stamped within the last day, and 10-ish rows
select count(*) as rows,
       (max(computed_at) at time zone 'America/Los_Angeles')::timestamp(0) as newest_pt,
       round(extract(epoch from (now() - max(computed_at)))/3600.0, 1) as hours_stale
from topshot_thin_fmv_editions;

-- expect: status 'succeeded' for both of the last two runs
select jobid, status, (start_time at time zone 'America/Los_Angeles')::timestamp(0) as start_pt,
       round(extract(epoch from (end_time - start_time))) as secs
from cron.job_run_details where jobid = 63 order by start_time desc limit 3;
```

👉 **PASS:** `hours_stale` under ~26 and job 63 `succeeded` ⇒ the lane self-heals; nothing to do.
⛔ **FAIL:** still timing out on Large ⇒ the duration was NOT the tier, the cost is in the function's
own work, and the lever becomes the query (the `cand` LATERAL over every Top Shot edition), **not** a
bigger ceiling. ⚠ Do not raise a timeout to make this pass.

## Check 2 — the cadence arm is DORMANT BY DESIGN until ~2026-09-21 17:30 PT

`pipeline_cadence_watchlist` gained a row for `refresh-conflated-editions` (migration
`20260920182954`, `medium`, 1800 / 3600). ⚠ **It cannot fire yet.** `detect_stalled_pipelines()`
carries a deliberate new-row grace — `w.created_at < now() - (w.max_silent_minutes * interval '1 minute')`
— so at 1800 minutes the arm is silent for **30 hours** after insertion. `created_at` was left TRUTHFUL
rather than backdated: the function reads it as *how long has this arm been armed*.

```sql
-- after 2026-09-21 17:30 PT: the lane should be ABSENT (healthy), not silent-because-graced
select jsonb_pretty(detect_stalled_pipelines()) as d;
```

👉 **Expected:** absent, because the 08:17 PT tick wrote a terminal row. ⛔ **If it appears with
`classification 'invoked_but_never_logged'`, the route is being killed again** — that is the real
signal this row exists for, and it means Check 1 failed too.

## Please do NOT re-derive these from scratch

- ⛔ The route's `p_ok` now means **the lanes worked**, not that the body reached its end, and every
  non-fatal counter starts `null` (unknown) rather than `0` (measured-none). Six tests were INVERTED to
  pin that. If a `lanes_failed` array shows up in `pipeline_runs.extra`, it is working as intended.
- ⛔ Every duration in the older thin-FMV material is a **SMALL-tier** sample; the instance moved to
  **Large at 2026-09-20 10:39:57 AM PT**. Re-derive, do not quote.
