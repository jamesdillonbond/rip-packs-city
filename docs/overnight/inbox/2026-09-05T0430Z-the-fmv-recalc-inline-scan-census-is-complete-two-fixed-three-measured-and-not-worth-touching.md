# The fmv-recalc inline-scan census is COMPLETE — two fixed, three measured and deliberately left alone

**Filed 2026-09-05 04:30Z (2026-09-04 21:30 PT) · Claude Code on Trevor's box, interactive · two SHIPPED (see ledger 2026-09-04), the rest is a measurement filed so nobody re-derives it**

This closes the measurement half of inbox [`2026-09-04T0500Z`](2026-09-04T0500Z-query-sql-is-the-top-reader-and-fmv-recalc-owns-it-seven-ad-hoc-scans-per-run.md), which sized `query_sql` as the database's #1 reader and attributed it to "this route's 7 inline scans" **without measuring them individually**. They are now all measured. They are not remotely equal, and the biggest one was not the one that looked worst.

## The premise was tested first, not inherited

The filing's load-bearing claim is that `query_sql` is *invisible by construction*. If that were false the whole restructure would be unnecessary, so it was checked: **`pg_stat_statements.track = top`**, and `select toplevel, count(*) from pg_stat_statements group by 1` returns **exactly one row, `toplevel = true`**. The inner `EXECUTE`s get no queryid. Confirmed.

Falsifier re-run the same evening: `ops_pgss_delta('24 hours')` still ranks `query_sql` **#1 at 11,893,325 blocks over 2,131 calls**, against 151 `fmv-recalc` runs. The filing holds.

## The census — all seven, warm, buffers not timings

| # | step | buffers BEFORE | buffers AFTER | disposition |
|---|---|---:|---:|---|
| 1+2 | **Step 5** census + candidates | 208,005 | **101,725** | ✅ merged, one anti-join |
| 3 | **Step 5b** historical fallback | 513,102 | **306,847** | ✅ reordered + 60 s timeout |
| 4 | Step 5c `edition_offers` ASK | 76,125 | — | ⛔ left alone |
| 5 | Step 5e parallel `::` ASK | 31,550 | — | ⛔ left alone |
| 6 | Step 5d All Day ASK | 43,331 | — | ⛔ left alone |
| 7 | Step 6 stale touch | *`forceStale` only* | — | not on the default path |
| | **total per tick** | **872,113** | **559,578** | **−36%** |

At 151 ticks/day that is **~47 M buffer accesses a day** removed. ⚠ This is a *route* number, not a share of the instance — do not restate it as a percentage of anything without re-deriving the denominator.

## What was actually wrong, in one line each

- **Step 5** ran the **same** `editions × fmv_snapshots` anti-join **twice**, and one of the two existed only to feed a `console.log` — 101,407 buffers, 151×/day, for one line in a Vercel log nothing reads.
- **Step 5b** was **being killed**: 38 of 459 runs (8.3%) over 73 h on `canceling statement due to statement timeout`, because the planner ran the *least* selective predicate first — an `EXISTS` over sales, as a merge semi join across **4,866,318 rows**.

Both are written up in full in the ledger (2026-09-04), including the equivalence proofs and the two alternatives that were considered and **rejected on measurement**.

## ⛔ Why the remaining three are NOT worth touching — stated so this is not re-opened

Together they are **151,006 buffers**, 27% of what remains and **17% of the original**. Individually:

- **5c (76,125)** — the plan is already sensible: a hash join builds first, and the LATERAL runs on 12,148 rows rather than the full catalogue. ⚠ **And its route header already records a FALSIFIED rewrite** — hoisting the predicate into a `COALESCE(...) = 'NO_DATA'` correlated subquery was measured at **120,508 buffers, i.e. WORSE**, and the header says do not re-try it. Read that header before touching this one.
- **5e (31,550)** and **5d (43,331)** — both collection-scoped and already driven from the small side (3,222 and 4,397 rows respectively).

The pattern that made 5 and 5b worth fixing — a non-selective predicate driving the join, or the same scan run twice — **is not present in any of these three**. Optimising them would be work whose upside is bounded by 17% and whose downside is a behaviour change on a pricing path.

## ⭐ The one thing here that generalises beyond this route

**`Heap Fetches` is large on `fmv_snapshots_2026` in EVERY one of these plans** — 17,294 of 26,722 probes in Step 5, 16,516 of 18,946 in 5b, 11,030 of 12,148 in 5c, 3,634 of 4,386 in 5d. That is an ~85–90 % heap-fetch rate on index-only scans, i.e. the visibility map is close to useless on that partition. Cause is structural: FMV writes are delete-then-insert on every tick, so the newest pages are never all-visible for long. `last_autovacuum` was **2026-09-04 17:56Z** and the rate was still ~89 % hours later.

⚠ **NOT filed as an action item, because I have not measured what it would buy.** A more aggressive autovacuum on `fmv_snapshots_2026` is the obvious lever and it is *not* obviously right on an IO-bound instance — vacuum is itself IO. **The honest next step is a measurement (what fraction of these buffers is the heap fetch, and what does a manual `VACUUM` of that partition change, warm-vs-warm), not a settings change.** Anyone acting on this should treat it as a hypothesis.

## Owed falsifier (from the ledger, repeated here so it is not lost)

`extra.historical_fallback_error` must reach **0 timeouts** over a full day of runs from 2026-09-05. ⚠ Read it as a **rate over ≥100 runs**, and **split at the deploy** (2026-09-05 ~04:30Z). The pre-fix rate was 8.3%, so **a dozen consecutive clean runs is what the null already predicts** (0.917¹² ≈ 36%) — that is not evidence of anything.

## Re-derive

```sql
select * from ops_pgss_delta('24 hours'::interval, 5);

-- the Step 5b falsifier, split at the deploy
select started_at > '2026-09-05 04:30Z' as post_fix,
       count(*) runs,
       count(*) filter (where extra->>'historical_fallback_error' is not null
                          and extra->>'historical_fallback_error' <> 'null') as timeouts
from pipeline_runs
where pipeline = 'fmv-recalc' and started_at > now() - interval '73 hours'
group by 1;
```
