# `get_fmv_coverage()` plans the SAME correlated `EXISTS` twice — and it took the whole data-integrity monitor down

Filed 2026-08-18 08:10 PT (15:10Z). Found while chasing the `FUNCTION_INVOCATION_TIMEOUT` that
`RPC Ops Monitor` started reporting once its own failure path was repaired earlier the same morning
(see the ledger entry for `ops-monitor`; before that fix this outage was invisible, showing only as
a bare `exit code 5`).

**The caller is fixed and shipped. The FUNCTION is not — that part is filed here.**

## What broke

`/api/cron/data-integrity` has `maxDuration = 30`. It made five sequential DB calls, **unbounded**.
`get_fmv_coverage()` did not finish in **55 s** (measured directly, `statement_timeout` cancelled
it), so the lambda died and the route returned **nothing at all** — including the
`check_public_security_invariants()` result, which was clean and instant. **A slow coverage metric
was taking the security check dark.** That is the defect that mattered; the coverage number itself
is informational.

⚠ **The route's own comment claimed the RPC was `~1.2s`, an "index-only semijoin".** Both halves
were wrong by 2026-08-18. It is the standing rule in the worst place: **a dated sample quoted as a
constant, inside the comment a reader trusts instead of measuring.**

## The plan — measured with plain `EXPLAIN` (free; it does not execute, which is the only usable
instrument during a saturation spell)

```
HashAggregate  (cost=12348.29..12348.46)
  ->  Hash Join  (rows=29288)
        ->  Seq Scan on editions e  (rows=29288)
  SubPlan 1
    ->  Append  (fmv_snapshots_2025 / _2026 / _2027)
  SubPlan 2
    ->  Append  (fmv_snapshots_2025 / _2026 / _2027)
```

**`SubPlan 1` and `SubPlan 2` are the identical `EXISTS`.** The function body writes it twice —
once for `fmv_editions`, once again inside the `round(...)` percentage — and the planner does not
collapse them. So: ~29,288 editions x 2 subplans, each an `Append` across three partitions, to
produce **one percentage**. It is not a semi-join and never was.

## Candidate fix — one probe per edition, measured by cost only

```sql
select c.slug,
  count(*)::bigint                                        as editions,
  count(fs.one)::bigint                                   as fmv_editions,
  round(count(fs.one)::numeric / nullif(count(*),0) * 100, 1) as coverage_pct
from public.editions e
join public.collections c on c.id = e.collection_id
left join lateral (
  select 1 as one from public.fmv_snapshots f where f.edition_id = e.id limit 1
) fs on true
where c.is_active = true
group by c.slug;
```

Equivalent by construction: the lateral yields exactly 0 or 1 row per edition, so `count(fs.one)`
counts editions having at least one snapshot — the same set `EXISTS` selects — and it is evaluated
**once**, reused by both aggregates.

| shape | planner cost | probes |
|---|---|---|
| live (two SubPlans) | **12,348** | ~58,600 |
| lateral, one probe | **8,709** | ~29,300 |

⚠ **That is a COST-MODEL comparison, not a timing.** I could not time either one honestly: the
instance was in a saturation spell (70% of active sessions in IO wait, an ~78-minute
`autovacuum: VACUUM public.wallet_moments_cache`). **Re-measure with `EXPLAIN (ANALYZE, BUFFERS)`
in a quiet window before shipping** — the cost model is a plan-choice heuristic, not a promise
about buffers.

## Why the function was NOT changed here

- It is **`SECURITY DEFINER`** (`prosecdef = true`, `search_path=public`), so a rewrite touches the
  security surface and wants `check_secdef_anon_exec_drift()` re-run after.
- It is FMV-adjacent, and the standing rule is that FMV objects are not changed on an autonomous
  judgement call.
- The caller bound is the smaller change and it is what stops the monitor going dark, which was the
  actual incident.

✅ **Blast radius is small and was enumerated before deciding**: exactly **one** production caller,
`app/api/cron/data-integrity/route.ts`. The only other repo hits are its test, a dated go-live doc,
and an archived inbox note. Nothing else reads it.

## What shipped instead

Both RPCs in the route now go through `rpcWithRetry(..., { timeoutMs })` — 8s for the security
invariant, 10s for coverage, against a 30s `maxDuration`, so the two cannot spend the budget
between them. `timeoutMs` is a **total** budget across attempts (shared deadline), and a timeout is
terminal rather than retried, so the bound holds regardless of retry settings. A timeout arrives as
an `error`, which drops into the route's existing honest branch: `fmv_coverage_pct: null`, not a
measured `0`.

⚠ **A HANG is not an ERROR — no error handling in that route could ever have caught this**, which
is why the existing "degrades safely on error" tests all passed while production returned nothing.
The new pin (`survives a coverage RPC that HANGS, and still reports the security check`) is
verified in **both** directions: with the bound removed it fails at the 5s test timeout, with the
bound it passes. It asserts the security check still reports, that coverage reads `null` rather
than a fabricated `0`, and that a hung dependency does **not** page ops as an integrity issue.

## Residual, stated rather than left implicit

The three table reads in that route (badge freshness + two `editions` counts) are still unbounded.
Measured 2026-08-18 they are cheap — `461ms` / `503ms` / index-backed, `2,014` and `161` buffers —
so they are not the current risk, but they are the same shape and `withQueryDeadline` exists for
them. Worth closing when someone is next in this file.
