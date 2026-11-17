# `refresh-insights-cache` fails to warm half its boards and has logged `ok: true` every single time

**Filed** 2026-08-15 12:00Z by Claude Code (interactive), found by pulling the breached
`public_board_slow_count` arm rather than from the backlog. **The observability half shipped**
(snapshot-staleness in the cron's own verdict); **the query-cost half is filed** — the remedy is
five view optimizations, i.e. migrations on public-board SQL.

## What the pipeline says vs. what happens

`pipeline_runs` for `refresh-insights-cache`, 869 ticks over 3.2 days (2026-08-12 06:45Z →
2026-08-15 11:45Z). **`ok` was `true` on every one.** Per-board, from the `extra->boards` payload:

| board | ok ticks | failed ticks | **fail %** | longest consecutive failure streak |
|---|---|---|---|---|
| **deals** | 352 | 517 | **59.5%** | **34 ticks ≈ 2h50m** |
| first-mint | 398 | 471 | 54.2% | 28 ≈ 2h20m |
| panini-squeeze | 426 | 443 | 51.0% | 25 ≈ 2h05m |
| rookies | 738 | 131 | 15.1% | 17 ≈ 85m |
| candy-mlb | 831 | 38 | 4.4% | 3 ≈ 15m |

The route's rule was `ok = okCount > 0`, with a well-argued comment: *"A single board timing out
under disk-IO saturation is EXPECTED … the run is ok as long as it warmed at least one board."*
⚠ **The reasoning is right and its premise is false.** Failures are not occasional and rotating —
they are the majority state for three of five boards, and `okCount > 0` was satisfied almost
entirely by **candy-mlb**, the one board that succeeds 95.6% of the time. So the healthiest board
on the list was silently vouching for the other four.

## Why the boards fail — already instrumented, and the telemetry is good

The per-board reasons added on 2026-08-12 name the exact views, and every one is the same fault:

```
deals:          cross_collection_deals_board: canceling statement due to statement timeout
rookies:        topshot_2025_rookie_cohort_stats + topshot_2025_rookie_index: … statement timeout
first-mint:     topshot_first_mint_trophy_stats + topshot_first_mint_trophies: … statement timeout
panini-squeeze: panini_squeeze_board: page 0: … statement timeout
```

`warmBoard` imposes no timeout of its own, so the ~31 s every tick takes is **Postgres's own
`statement_timeout=30s` for `service_role`** killing each query. Corroborated independently by the
board liveness probe, which currently reads (against per-view budgets):

| view | elapsed | budget | over |
|---|---|---|---|
| candy_pack_market | 128.8 s | 3 s | **42.9×** |
| candy_scarcity_board | 96.9 s | 3 s | 32.3× |
| candy_parallel_premium | 96.0 s | 3 s | 32.0× |
| candy_special_serials_board | 33.5 s | 4.1 s | 8.2× |
| panini_squeeze_board | 7.6 s | 3 s | 2.5× |
| allday_scarcity_board | 17.6 s | 8.3 s | 2.1× |

⚠ `candy_pack_market` is **128.8 s for a ONE-ROW result** — and it is behind a PUBLIC board
(`/insights/candy-mlb`, public since 2026-07-31). The Candy views have been 15–146 s for at least
5 days, so this is chronic, not a spike. `public_board_slow_count` has gone **3 → 9** since the
figure recorded in CLAUDE.md.

## User impact — real but bounded, and worth stating precisely

Users are **not** seeing empty boards. `readBoardOrLive` serves the last-good snapshot with its own
age stamp, which is the ladder working as designed. What they see is a board that can be **up to
~3 hours stale** while every instrument reports health. For `deals` — a below-FMV board whose whole
value is timeliness — that is a product problem, not just an ops one.

⚠ **A stale-cache render is deliberately NOT flagged as degraded** (documented: it serves complete
last-good data with an age stamp, and flagging it would cry wolf on the cache working). That
decision is right, and it is exactly why the staleness had to become visible somewhere else.

## What shipped (2026-08-15)

`readBoardSnapshotAges()` + `stalestBoards()` in `lib/insights/board-cache.ts`, used by the cron:

- `ok = warmedSomething && stale.length === 0` — the per-tick rule is KEPT and a cumulative
  condition added. **Ceiling chosen from the measured distribution, not taste**: of 414 failure
  streaks, 75 reached 30 min, 34 reached 1 h, and only **4 reached 2 h**. So 2 h fires ~1.2×/day on
  the genuinely exceptional case and stays quiet through ordinary rotation.
- `extra.snapshot_age_min` / `stale_boards` / `never_warmed` so a streak is queryable directly
  instead of being reconstructed from per-tick rows that prune at ~73 h.
- ⚠ An **unknown** age (no snapshot row, or a failed read) is deliberately **not** reported as
  stale — manufacturing the finding out of our own missing data is the failure this repo keeps
  paying for. It is counted separately as `never_warmed`.
- The age read selects only `board_key, refreshed_at`; panini's payload is multi-MB.

⚠ **This does not page anyone yet, and that is stated in the code.** Nothing consumes
`pipeline_runs.ok` for this pipeline: `get_pipeline_alerts_core` is driven by
`silent_indexer_failures` + `event_cursor`, and `detect_stalled_pipelines` watches **cadence** —
which is perfect here, because the cron ticks reliably and it is the work *inside* that fails.
**Adding a `pipeline_cadence_watchlist` entry would therefore not help either.** Wiring an alarm
needs a consumer that reads `ok`/`extra` for this pipeline.

## The query-cost half — NOT taken

Five views need to come under 30 s: `cross_collection_deals_board`,
`topshot_2025_rookie_cohort_stats`, `topshot_2025_rookie_index`, `topshot_first_mint_trophy_stats`,
`topshot_first_mint_trophies`, `panini_squeeze_board`, plus the three Candy views above.

### Measured 2026-08-15 (addendum) — three facts that change what to try

From `pg_stat_statements` (3 d 09 h window), per backing view:

| view | calls | mean | max |
|---|---|---|---|
| cross_collection_deals_board | 430 | 12,100 ms | 29,782 ms |
| topshot_first_mint_trophies | 485 | 11,873 ms | 29,977 ms |
| topshot_first_mint_trophy_stats | 484 | 11,840 ms | 29,837 ms |
| topshot_2025_rookie_index | 836 | 10,629 ms | 29,446 ms |
| topshot_2025_rookie_cohort_stats | 851 | 10,137 ms | 29,264 ms |
| panini_squeeze_board | 2,559 | **3,381 ms** | 29,718 ms |

**1. Serialization is arithmetically impossible — that sub-question is now CLOSED.** The sum of
the six means is **59,960 ms ≈ 60.0 s**, which is exactly the route's `maxDuration`. So a serial
warm would consume the entire lambda budget on an *average* tick with zero headroom, and any
worse-than-average tick would be killed mid-run. Do not propose it again.

**2. These are not slow queries — they are starved ones.** Every max is ~29.x s, i.e. the 30 s
`statement_timeout` ceiling rather than a natural cost, while every mean is 10–12 s. The clincher
is `panini_squeeze_board`: a **3.4 s mean** query that fails **51%** of ticks. A query that
typically finishes in under four seconds does not fail half the time because it is expensive. It
fails because four siblings are running against the same 2-core / 2 GB instance at that moment.

**3. The starvation is DETERMINISTIC, not random — and it is self-reinforcing.** The same three
boards lose every time (59.5 / 54.2 / 51.0%) because they are the heaviest; `candy-mlb` wins 95.6%
because it is cheap. `Promise.all` gives no board a head start, so the ordering is decided purely
by cost. ⚠ And each failure burns a **full 30 s of database time to produce nothing** — on a
typical tick three boards fail, so the warm cron spends **~90 s of DB work per 5-minute tick
generating zero rows**, on the instance whose only problem is contention. The refresher is a
meaningful contributor to the saturation it exists to survive.

### What to try, and what NOT to

⚠ **Both obvious fixes are gambles and neither should be shipped on reasoning alone.**

- **Bounded concurrency (2 at a time)** fits the arithmetic — 3 waves × ~12 s ≈ 36 s — and halves
  the contention. But if a wave hits the 30 s ceiling the waves serialize to 90 s, past
  `maxDuration`, and the last wave is never attempted: strictly worse than today for those boards.
- **A sub-timeout warm bound** (abort at ~15 s instead of letting Postgres kill at 30 s) would cut
  the wasted DB time in fact 2 identifies, and `.abortSignal()` genuinely cancels the statement.
  ⚠ But with a 12 s mean, an unknown share of *successful* warms take longer than 15 s, so this
  could convert successes into failures. It needs the per-call latency DISTRIBUTION, which
  `pg_stat_statements` does not retain — only mean and max.
- **Rotating a subset per tick** (candy + one heavy board) would give each heavy board a nearly
  uncontended run, at the cost of moving its refresh interval from 5 min to ~20 min. Today those
  boards refresh every ~10–12 min at best and up to **2h50m** at worst, so a guaranteed 20 min is
  better than the status quo's worst case and worse than its best. **That is a product trade-off
  (freshness vs. reliability), not an engineering one** — Trevor's call.

### UPDATE 2026-08-15 — the first view fix SHIPPED (`audit_20260815_deals_board_prune_empty_fmv_partitions`)

Profiled the arms of `cross_collection_deals_board` individually. **`topshot_deals_vs_fmv` alone
measured 42,333 ms** — past the 30 s `statement_timeout`, which is the whole reason `deals` fails
59.5% of ticks. Its correlated LATERAL runs **6,246 times**, and the **empty `fmv_snapshots_2027`
partition was probed on every one** at 2 buffers each: **12,492 buffers, 30% of the query's entire
buffer traffic, for zero rows.** The AllDay arm did the same 2,229 times (4,458 buffers, 18.6%).

Shipped `AND fs.computed_at <= now()` into both LATERALs in ONE migration (one schema-cache burst
instead of two). **Verified after apply: output byte-identical** — md5
`5c1d65ba581f8544a8647a85477b6766`, 18 rows, unchanged — with `Subplans Removed: 1` confirming
runtime pruning. **Buffers 41,044 → 28,566 (−30.4%)**, exactly the predicted saving.

⚠ **It is an IMPROVEMENT, NOT A FIX, and the board will still fail some ticks.** Post-change the
query still measures ~30.5 s under load, because the remaining cost is 6,246 correlated probes into
`fmv_snapshots_2026` at ~4.8 ms each — IO-bound on a 2 GB instance, not a plan defect. Time on this
instance is too noisy to quote as a speedup; **the buffer reduction is the deterministic result.**

⚠ **The obvious next step was TESTED AND IS WORSE.** Replacing the LATERAL with a
`DISTINCT ON (edition_id)` CTE over the Top Shot partition **timed out at 60 s**. The correlated
probe is the right shape here — do not "fix" it that way.

⚠ **DO NOT blanket-apply the predicate.** **101 objects** (83 functions + 18 views) match a loose
"correlated `fmv_snapshots` + `ORDER BY computed_at DESC`" scan, but the empty-partition waste only
matters where the lookup is executed **per row**; in a once-per-query CTE it costs 2 buffers total.
Each candidate needs its own measurement, and 101 redefinitions in one migration would be reckless.

### UPDATE 2026-08-15 (later) — the remaining views were profiled and MOST OF THIS LIST IS ONE ROOT CAUSE

Worked the rest of the failing views. **Two of the three came back as "do not optimize".**

**`topshot_first_mint_trophies` — no win available, do not spend a session on it.** Measured
**7,187 ms**, i.e. comfortably under the 30 s ceiling; it fails only under contention. Its
`other_serial_avg` CTE aggregates **668,750 rows into 11,306 groups** and the join then discards
94% of them (only ~693 editions have a mint-one sale), which looks like an obvious win. It is not:
restricting the CTE to `edition_id IN (SELECT … FROM mint_one_sales)` was tested and moved buffers
**68,479 → 68,693 — slightly WORSE**. The predicate does not push into the index scan
(`edition_id` is an INCLUDE column, not a key), so it still reads all 668,770 rows and merely
hash-filters afterwards. The apparent 7.2 s → 4.7 s was noise plus a smaller hash. A real fix needs
a new index on `sales_2026`, a huge hot table — not worth it for a view that is already under
budget.

**The Candy views are NOT slow queries and there is NOTHING TO FIX in them.** `candy_pack_market`
reads `candy_packs` (2,501 rows), `candy_pack_sales` (387), `candy_pack_listings` (332) and
`candy_pack_ev_model` (planner cost **292**) — a **~2.5 MB total working set**. It measured
**128.8 s**. No plan defect can explain that ratio. Anyone sent to "optimize the Candy views" by
the `public_board_slow_count` breach will find nothing, which is why this is written down.

### ⚠ ROOT CAUSE, OBSERVED LIVE — the instance is out of disk-IO budget

While profiling, ordinary queries began timing out — a `LIMIT 5` against an **empty** table
exceeded 60 s. `pg_stat_activity` at that moment:

```
state   wait_event_type  wait_event      n   oldest_s
active  IO               DataFileRead    9   361
active  IO               DataFileWrite   2   85
active  Lock             transactionid   1   2
idle    Client           ClientRead      23  (pooler, normal)
```

**Every active backend was blocked on `DataFileRead`**, the oldest for six minutes. That is the
documented burst-credit model at depletion: the instance throttles to its ~22 MB/s baseline and all
reads queue. It is disk-IO-bound, not compute-bound — *"fix expensive queries, don't upgrade the
tier (Medium is the same 2 cores for 4×)."*

**So this list is not N independent fixes; it is one root cause and a set of contributors.** The
board timeouts, the entity-page pool-acquire family (`2026-08-15T0450Z`), the `fmv-recalc` kill
rate and the Candy 128 s are all the same condition seen from different surfaces. The only lever
that works is **reducing total disk-read volume**, which is what actually moved things this week:
the `deals` partition pruning (−30.4% buffers), the 113 GB backfill re-scoping, the 27 GB/day
insider telemetry sampling, and the 72 MB unused-index drop. Per-query plan tuning on already-cheap
views does not.

⚠ **METHOD NOTE, because I was part of the problem.** Diagnosing this cost several
`EXPLAIN (ANALYZE)` runs at 42 s, 30 s, 7 s and 4.7 s against the same starved instance. On a
burst-credit database, profiling is itself load — batch the measurements, prefer `EXPLAIN` without
`ANALYZE` and `pg_class.reltuples` over `count(*)`, and stop when the instance starts refusing
trivial queries rather than pressing on.

The durable fix underneath all three is making the six views cheaper, which is the migration work
at the top of this section. Related: the entity-page timeout filing (`2026-08-15T0450Z`) reaches
the same conclusion from the other direction — the platform's bottleneck is concurrent connections
against a small instance, not individual query plans.
