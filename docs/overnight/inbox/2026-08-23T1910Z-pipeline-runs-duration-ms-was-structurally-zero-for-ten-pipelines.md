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

---

## ✅ VERIFIED BY A BEFORE/AFTER ON THE SAME PIPELINES — 2026-08-23 ~13:45 PT (20:45Z), by a second session

Split `pipeline_runs` at the apply time (`20260823190648` = **19:06:48Z**) over a 48-hour window, and keep
only pipelines with **≥5 runs before and ≥2 after** whose `max(duration_ms)` was **exactly 0 before and > 0
after**. That is the same-pipeline control this fix needed, rather than a claim from the post-fix side alone:

| pipeline | runs before | runs after | max before | max after |
|---|---:|---:|---:|---:|
| **`panini-squeeze-mv`** | 34 | 3 | **0** | **379,698 ms** |
| `topshot-atlas-pack-ev` | 34 | 2 | **0** | 104,055 ms |
| `cross-collection-deals-mv` | 39 | 3 | **0** | 67,460 ms |
| `pack-ask-hourly-low-roll` | 172 | 7 | **0** | 41,777 ms |
| `topshot-first-mint-mv` | 42 | 3 | **0** | 33,295 ms |
| `series-detail-rollup` | 24 | 2 | **0** | 4,046 ms |

**172 consecutive runs of `pack-ask-hourly-low-roll` reported zero**, and the first seven after the fix report
up to **41.8 s**. That is the clamp, not a change in the work.

⚠ **This is SIX, and the filing says TEN — the difference is my SAMPLING BAR, not a claim that four are
unfixed.** Pipelines that run less often than ~5 times in the pre-window, or fewer than twice since, are
excluded by construction. **Re-run the split with a wider window before concluding anything about the other
four.**

⭐ **The number nobody had: `panini-squeeze-mv` is the largest of the six at 379.7 s** (avg 290 s over three
runs). That is worth knowing next to the standing note that `panini_squeeze_board` is ~4.5% of the disk-IO
budget while **79% of its refreshes are discarded** — but ⚠ **this is a RECORDING, not a new investigation**,
and `focus.md` is explicit that saturation symptoms are one root cause and must not be re-opened separately.

⚠ **Do NOT sum `duration_ms` across pipelines as a budget figure.** These are wall-clock durations of
overlapping jobs, many of them concurrent HTTP routes — summing them produced 87 hours of "work" in a
24-hour window on the first attempt. It is a per-run cost, not a share of the instance.

⭐ **The "other four" question above is CLOSED by the next section** — a full-population sweep
over every pipeline written since the apply time, rather than the ≥5-before/≥2-after subset.

## ✅ ROLLOUT CONFIRMED 2026-08-23 20:58Z — all ten fixed, zero residual inversions, and one look-alike that must be left alone

**By:** Claude Opus 5, Cowork cloud. The one-word change (`finished_at := clock_timestamp()`) went
live at **19:06:48Z**. Measured across **everything** written since, not just the three pipelines
I had spot-checked:

```sql
select pipeline, count(*) runs,
       count(*) filter (where finished_at < started_at) still_inverted,
       count(*) filter (where duration_ms = 0)          zero_duration
from pipeline_runs where started_at > '2026-08-23 19:06:48+00' group by 1;
```

**~100 distinct pipelines, 800+ runs, `still_inverted` = 0 on every single one.** All ten named in
the filing above now record real elapsed time. Spot values from the window:
`panini-squeeze-mv` 379,698 ms · `drain-conflated-subeditions` 295,187 ms ·
`allday-lock-refresh` 281,304 ms · `promote_unmapped_sales` 277,215 ms ·
`lock-check-batch` 207,523 ms · `fmv-recalc` 203,367 ms · `series-detail-rollup` 4,046 ms.

⚠ **The window is 19:06:48Z→20:58Z, about 1 h 51 m.** `pipeline_runs` retains 72.7 hours, so a
longer read is possible but would mix pre-fix rows back in; state the window from
`min(started_at)` rather than assuming a day.

### ⛔ Fourteen pipelines still read duration_ms = 0, and that is CORRECT. Do not "fix" them.

They are **not** inverted (`still_inverted` = 0 for all of them) — they are instantaneous marker
rows, and every one but the last is named `*-heartbeat`:

```
snapshot-pack-asks-heartbeat            fmv-recalc-heartbeat
golazos-sales-indexer-heartbeat         allday-sales-indexer-heartbeat
topshot-sales-indexer-heartbeat         allday-listings-indexer-heartbeat
golazos-listings-indexer-heartbeat      allday-listings-retry-heartbeat
pinnacle-listings-indexer-heartbeat     allday-pack-listings-heartbeat
drain-fmv-cold-tail-heartbeat           sales-seller-recovery-dune-heartbeat
classify-acquisitions-multicollection-heartbeat
editions-hydrate-at-insert
```

The pairing proves it: `snapshot-pack-asks` logged 21 runs with real durations in the same window,
and `snapshot-pack-asks-heartbeat` logged 21 runs at 0. The heartbeat is a companion row marking
"this ran", written at a single instant — `started_at == finished_at` is its honest value.

⚠ **This is the trap the original filing set up.** Anyone who re-runs the "which pipelines report
duration_ms = 0" query as a regression check will get **fourteen hits and conclude the fix did not
take.** The discriminator is not `duration_ms = 0`, it is `finished_at < started_at`. Use that.
