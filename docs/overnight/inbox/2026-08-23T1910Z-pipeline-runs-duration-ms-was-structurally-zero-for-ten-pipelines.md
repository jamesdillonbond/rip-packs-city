# `pipeline_runs.duration_ms` was structurally 0 for ten pipelines — and fixing it immediately exposed a 37.8 s job and a 78.4 s job that had always reported 0 ms

**Filed 2026-08-23 (PT) 12:10 by Claude (Cowork, cloud). SHIPPED — one word, one function.**
Saturation control at measurement time: `io_wait=4 / active=4 / total=43` — the quiet window the
[18:12Z monitor filing](2026-08-23T1812Z-daytime-monitor-saturation-spell-symptoms.md) said to
wait for.

## How it surfaced

Reading the 18:59 tick of `series-detail-rollup` to confirm a fix, its row said
`duration_ms = 0` with `finished_at = 18:59:00.0905` — **26 ms BEFORE**
`started_at = 18:59:00.1162`. Inverted, not rounded.

## Mechanism — one line

`log_pipeline_run(...)` hardcoded `finished_at = now()`, which is **transaction start**. Every
caller passes `p_started_at := clock_timestamp()` captured at function entry, which is
necessarily **later**. So `finished_at < started_at` on every such run, and the generated column

```sql
GREATEST(0, (EXTRACT(epoch FROM (finished_at - started_at)) * 1000)::integer)
```

floors the negative to 0.

⚠ **The `GREATEST` is what made it silent.** Without the clamp a negative duration would have
been obvious the first time anyone rendered this column. A guard that hides its own input is the
same shape as the `999` board-liveness sentinel and the `window_never_attempted` arm — **a metric
that cannot reach its clean value is not a metric.**

## Blast radius — 100% of every affected pipeline's runs

⛔ **WINDOW CORRECTION (made before anyone read this).** I first wrote these counts as "30 days".
`pipeline_runs` **retains 72.7 hours** — measured: oldest row 2026-08-20 18:41Z, newest
2026-08-23 19:25Z, 47,264 rows total. My query said `started_at > now() - interval '30 days'`
and the table simply has nothing older, so the predicate was decorative. **The counts below are
real; the window is ~3 DAYS, not 30.** Longer history lives in `pipeline_runs_daily`.
ⓘ This makes the finding WORSE, not better: 1,676 inverted rows is three days of output, not a
month of it.

| pipeline | runs | inverted | avg inversion |
|---|---|---|---|
| `promote_unmapped_sales` | 1,249 | 1,249 | **12.053 s** |
| `pack-ask-hourly-low-roll` | 272 | 272 | 0.017 s |
| `topshot-first-mint-mv` | 42 | 42 | 0.022 s |
| `cross-collection-deals-mv` | 39 | 39 | 0.016 s |
| `panini-squeeze-mv` | 34 | 34 | 0.015 s |
| `series-detail-rollup` | 24 | 24 | 0.014 s |
| `refresh-special-serial-owners-mv` | 6 | 6 | 0.029 s |
| `pinnacle-fmv-recalc` | 6 | 6 | 0.012 s |
| `weekly-db-maintenance` | 3 | 3 | 0.013 s |
| `weekly-wmc-prune` | 1 | 1 | 0.039 s |

**1,676 rows, 10 pipelines, not a sample — in ~3 days.** 5,461 of the 47,264 rows the table
holds carry `duration_ms = 0`.

💡 **The magnitude separates two sub-classes.** Nine sit at 12–39 ms — the plain
transaction-start-vs-`clock_timestamp` gap, and their historical durations are simply gone.
`promote_unmapped_sales` sits at **12.05 s**, far too large for that gap; for it the inversion
approximates the real runtime. ⓘ It also writes its own `duration_ms` inside `extra`, so its
history is **not** lost — read `extra->>'duration_ms'` there, not the column.

## The fix, and what it revealed within minutes

`now()` → `clock_timestamp()` in the INSERT. One word, one function, **no caller changes**;
strictly better for every caller including the 3-arg wrapper that passes `p_started_at := now()`.
`audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp`.

First runs after the change:

| pipeline | previously logged | actual |
|---|---|---|
| `series-detail-rollup` | 0 ms | **4,046 ms** |
| **`pack-ask-hourly-low-roll`** | 0 ms, 272 runs running | **37,849 ms** |
| **`promote_unmapped_sales`** | 0 ms | **78,443 ms** |

⭐ **That is the finding, not the typo.** Two jobs that have been reporting *zero* were taking
**37.8 s** and **78.4 s**. Both run frequently. Both were invisible to any duration-ranked board,
arm or triage — including every attempt this month to work out what saturates this instance. The
known band class has had two contributors hiding behind a clamp.

⚠ `promote_unmapped_sales` is only **partly** fixed — 2 of its 4 runs since the change are still
inverted, so it has a second write path that does not route through `log_pipeline_run` (no DB
function contains both strings; it is app or edge-function code). **Not chased here.**

## Why it mattered today, concretely

`series-detail-rollup` now backs 26 indexable pages. It **failed at 600 s** at 17:59 and
**succeeded in 4 s** at 18:59. In `pipeline_runs` both are `duration_ms = 0`. The only place the
real number existed was `cron.job_run_details`.

## Not done

- **Historical rows are not rewritten.** `duration_ms` is `GENERATED ALWAYS`; recomputing means a
  table rewrite over 47k+ rows for data that is unrecoverable for nine of the ten. Pre-migration
  rows stay 0; everything after is real.
- **The second `promote_unmapped_sales` writer** is unidentified.
- **Consider dropping the `GREATEST`** — or making it `NULL` rather than `0` on an inversion — so
  the next instance of this fails loudly instead of reading as instantaneous. Not shipped: it is a
  generated-column change and therefore a table rewrite.
