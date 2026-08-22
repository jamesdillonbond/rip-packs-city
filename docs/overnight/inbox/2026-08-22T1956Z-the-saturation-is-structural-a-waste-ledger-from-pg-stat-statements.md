# The saturation is structural, not a spell — a measured waste ledger

**Filed 2026-08-22 12:56 PT (19:56Z), Claude Code interactive. MEASUREMENT ONLY — nothing shipped,
nothing changed. Two of my leading hypotheses were refuted on the way in; both refutations are below,
because they are the part most likely to be re-derived wrongly by the next session.**

Window: `pg_stat_statements` since its reset **2026-08-12 01:34Z = 10d 18h**, `dealloc = 0` (nothing
evicted, so every percentage below is over the complete population). Cron figures are the trailing
**7 days** from `cron.job_run_details`. Re-derive before quoting: these are dated samples.

---

## 0. The baseline — this is not an intermittent spell

| instrument | reading |
|---|---|
| `sum(shared_blks_read)` over the window | **8,227 GB** = **765 GB/day** ≈ **8.9 MB/s sustained** |
| throttled disk-IO baseline (Small compute, credits depleted) | 22 MB/s |
| `sum(total_exec_time)` | **1,171 hours** of query execution in **258 hours** of wall clock |
| implied concurrency | **≈4.5 backends busy at all times**, on a **2-core** instance |
| `temp_blks_written` (window) | 64 GB (`work_mem` = 5 MB) |
| buffer miss rate | 1.89% — the cache is *working*; the read VOLUME is the problem |

⚠ **4.5 continuously-busy backends on 2 cores is the finding.** Nothing has to go wrong for this
instance to be saturated — the steady state already is. Every "saturation spell" in the ledger is this
floor plus a bump. Chasing individual slow queries will not move it; the aggregate cadence will.

---

## 1. REFUTED #1 — "Panini and Candy are gated pre-launch, so warming them is pure waste"

The two unpublished collections are the #3 and #4 read consumers:

- `panini_squeeze_board` — 5,276 calls, **375 GB (4.6% of all reads)**, 71 MB/call, mean 4,470 ms
- seven `candy_*` boards + `mv_candy_holder_board` — **≈316 GB (3.8%)** combined
- `panini_card_serials` is the **#3 seq-scanned table**: 8,848 seq scans × 138 MB = **1.19 TB**

Both collections are `collections.is_active = false`. `proxy.ts` gates both surfaces. The route header
on `app/api/public/insights/panini-squeeze/route.ts` still opens with **"STAGED: gated pre-launch"**.
Every one of those signals says *pre-launch*, and the conclusion "8.4% of the database's disk reads are
warming boards nobody can see" writes itself.

**It is wrong.** `lib/launch-flags.ts` has `CANDY_MLB_PUBLIC = true` (flipped 07-31) and
`PANINI_PUBLIC = true` (flipped 08-01). Both boards are live public product. The traffic is legitimate.

⚠ **`collections.is_active` is NOT the launch switch for an /insights surface** — the flag file says so
explicitly and lists the three independent switches. The stale "STAGED" comments are the trap: a header
comment describes the state on the day it was written, and a one-line flag flip does not revisit it.
**Read `lib/launch-flags.ts`, never a route header, to learn whether a surface is public.**

*(Worth a separate low-risk cleanup: the "STAGED / gated pre-launch" headers in
`app/api/public/insights/panini-squeeze/route.ts` and the `proxy.ts` gate comments now describe a state
that ended three weeks ago.)*

## 2. REFUTED #2 — "the warm cron abandons boards at 8s while the query keeps running"

`BOARD_LIVE_TIMEOUT_MS = 8_000` and `lib/insights/board-cache.ts` documents, in its own words, that
"the abandoned query keeps running server-side — supabase-js has no cancel." Board views average
11.5–16.7 s. The inference — the cron pays full IO and abandons every one of them — is tidy and false:
**`warmBoard` calls `live()` directly with no budget at all.** The 8s bound is on `readBoardOrLive`
(the render path), not the warm path.

The real ceiling is **`service_role`'s `statement_timeout = 30s`** (`pg_roles.rolconfig`), and it shows
up as a hard fingerprint: *every* board statement's `max_exec_time` sits at **29,4xx–29,9xx ms**.

---

## 3. What IS waste, ranked

### 3.1 `refresh-insights-cache` runs every 5 minutes and stores nothing for 3 of its 5 boards

`vercel.json`: `/api/cron/refresh-insights-cache` at `*/5 * * * *` = **288 ticks/day**. Per-board outcome
over the trailing **48 h / 516 ticks**, from `pipeline_runs.extra->'boards'`:

| board | ticks | warmed | **fail %** |
|---|---|---|---|
| `panini-squeeze` | 516 | 124 | **76.0** |
| `deals` | 516 | 130 | **74.8** |
| `first-mint` | 516 | 223 | **56.8** |
| `rookies` | 516 | 427 | 17.2 |
| `candy-mlb` | 516 | 443 | 14.1 |

Per-call cost of the backing views (all plain views — `relkind = 'v'` — recomputed from scratch every
call, no materialization):

| view | calls | mean ms | max ms | MB/call | GB total |
|---|---|---|---|---|---|
| `panini_squeeze_board` | 5,276 | 4,470 | 29,930 | 71 | 375 |
| `topshot_first_mint_trophy_stats` | 1,565 | 13,096 | 29,945 | 52 | 79 |
| `topshot_first_mint_trophies` | 1,532 | 13,085 | 29,977 | 52 | 78 |
| `cross_collection_deals_board` | 984 | 12,905 | 29,813 | 78 | 75 |
| `candy_scarcity_board` | 676 | 16,658 | 29,834 | 95 | 62 |

**Every failure is a full-price read whose result is discarded**, and the expensive runs are exactly the
ones that fail — a run that dies at the 30s wall did the most IO of any run that tick. Then the discard
compounds: with nothing written, `public_board_snapshots` ages past the 120-min
`BOARD_SNAPSHOT_STALE_CEILING_MS`, and every page render falls through the ladder to a **live** query.
Observed at filing, climbing linearly across consecutive ticks (156 → 165 → 170 → 175 min): `deals` and
`panini-squeeze` had not warmed successfully in **~3 hours**, with `stale_ceiling_min: 120`.

**Caught live during this session**, `pg_stat_activity`: **7 backends ACTIVE, every one
`wait_event_type = 'IO'`**, oldest 30s, all on `cross_collection_deals_board`.

⚠ **The cadence is set far above the rate at which these boards can complete.** A board averaging 13s
against a 30s wall, retried every 300s, is not a cache being kept warm — it is a load generator.

### 3.2 ~~The failure telemetry is recording NULL~~ — **RETRACTED, I was reading the wrong column**

⚠ **This section originally claimed the warm telemetry records no reason. That is WRONG, and the
retraction is the useful part.** I queried `extra->'boards'[].error`, which by design carries only
`{key, ok, row_count}`. The reasons live in the **`pipeline_runs.error` COLUMN**, they are complete, and
they are unanimous:

```
deals: cross_collection_deals_board: canceling statement due to statement timeout;
first-mint: topshot_first_mint_trophy_stats: canceling statement due to statement timeout,
            topshot_first_mint_trophies: canceling statement due to statement timeout;
panini-squeeze: panini_squeeze_board: page 0: canceling statement due to statement timeout
```

**Every single failure is the `service_role` 30s wall** (`pg_roles.rolconfig`), which is also why every
board statement's `max_exec_time` is pinned at 29.4–29.9s. The `page 0` / `page 1` prefix shows panini's
fetch is PAGED — several 30s-capable statements per warm, which is why its call count (5,276) exceeds the
tick count. **Read the column before concluding an instrument is silent.**

### 3.3 A quarter of all pg_cron execution time is rolled back on a statement timeout

Trailing 7 days, `cron.job_run_details`:

| status | runs | hours | share of cron time |
|---|---|---|---|
| succeeded | 26,152 | 195.6 | 74.8% |
| **failed** | **1,826** | **66.0** | **25.2%** |

**66 hours of DB work in a 168-hour week, discarded.** Near-100% of the failed messages are
`canceling statement due to statement timeout`. Worst offenders (failed hours / fail rate):

| job | schedule | failed h | fail % |
|---|---|---|---|
| `rpc-backfill-historical-pack-ev` | `13 * * * *` | 7.85 | 30 |
| `rpc-atlas-pack-ev` | `25 * * * *` | 6.01 | 27 |
| `rpc-refresh-mv-pack-ev-latest` | `3,33 * * * *` | 4.53 | 14 |
| `rpc-refresh-allday-pack-realized` | `35 */6 * * *` | 3.33 | **74** |
| `rpc-backfill-wmc-fmv-confidence` | `2-59/5 * * * *` | 3.24 | 9 |
| `rpc-allday-nem-from-sales-backfill` | `37 * * * *` | 2.85 | 17 |
| `rpc-thin-sale-ask-disclosure-refresh` | `25 9 * * *` | 0.67 | **100** |

⚠ **`rpc-thin-sale-ask-disclosure-refresh` has never succeeded** in the window (4/4 failed);
`rpc-refresh-allday-pack-realized` fails 3 runs in 4. These do ~10 minutes of work per attempt and
**roll all of it back** — the batch sizes are set above what the timeout can finish, so the work can
never land no matter how often it is retried.

Separately, **677 launches returned `job startup timeout`** (pinnacle-mints 247, allday-pack-sales 157,
topshot-pack-sales 137, allday-dist-opened 136) — pg_cron could not obtain a background worker. That is
a *symptom* of the saturation, not a cause, and it means those ingest ticks silently did not run.

### 3.4 `refresh_wmc_fmv_changed` — the single largest consumer, at ~47% duty cycle forever

| metric | value |
|---|---|
| schedule (`jobid 303`) | `7-57/10 * * * *` — **every 10 minutes** |
| runs / avg / max (7d) | 1,004 · **285.9 s** · 806.8 s |
| runtime in a 168h week | **79.7 hours = 47% of one backend, continuously** |
| reads (window) | **684 GB = 8.3% of all disk reads**, 552 MB/call |
| `total_exec_time` | 380,084 s = **9.0% of all query time in the database** |

**It is not broken** — `rwfc_state.last_cutoff` was only **17m 45s** behind at filing, so it is keeping
pace. This is the `fmv-recalc` shape again: **wasteful, not broken.** It spends half of every ten
minutes keeping a *denormalized copy* of `fmv_usd` inside `wallet_moments_cache` (2,842 MB) in sync,
and `prosrc` shows why it costs what it does — **`v_chunk constant integer := 5`**, i.e. one full
statement (temp-table `DELETE … RETURNING` + a per-edition correlated `ORDER BY computed_at DESC LIMIT 1`
+ a join-UPDATE against the 2.8 GB cache) **per 5 editions**, looping until a deadline of
`0.6 × statement_timeout`. It exits on the clock, never on the work.

The comment pins the chunk to "the SMALLEST caller budget (service_role 30s), never scaled up" — but
the pg_cron caller runs as `postgres`, whose budget is minutes, not 30s. **The chunk size is sized for
the wrong caller.** Any re-tune must be measured in **buffers**, not ms (a saturation spell confounds
timing in both directions), and re-measured at a quiet hour.

### 3.5 Sequential scans, and `sales` partitions that are not pruning

`pg_stat_user_tables`, `seq_scan × pg_relation_size`:

| table | seq scans | heap | scanned bytes |
|---|---|---|---|
| `wallet_moments_cache` | 1,965 | 927 MB | **1.78 TB** |
| `sales_2026` | 4,596 | 289 MB | **1.30 TB** |
| `panini_card_serials` | 8,848 | 138 MB | **1.19 TB** |
| `allday_pack_sales_history` | 6,298 | 141 MB | 870 GB |
| `topshot_pack_sales_history` | 5,277 | 168 MB | 866 GB |
| `pack_rips` | 942 | 756 MB | 696 GB |

⚠ **The cold `sales` year-partitions are being scanned too** — `sales_2023` 951×, `sales_2022` 415×,
`sales_2025` 815×, against `sales_2026`'s 4,596. Partitions that receive no new rows are being read
~20% as often as the live one, which means **some caller queries `sales` with no `sold_at` predicate**
and fans out across every partition. Prime suspects by read volume: `promote_unmapped_sales` (138 GB +
104 GB across two signatures), `resolve_unmapped_sales_for_collection` (114 GB, mean **76 s**),
`backfill_nft_edition_map_from_sales` (67 GB, mean **188 s**, max 590 s).

⚠ **Do NOT read `n_live_tup` here as a row count** — I nearly filed "`pack_rips` is 83.8% dead tuples,
never autovacuumed." `pg_stat_user_tables` counters were reset with the stats collector;
`last_autovacuum` is NULL and `autovacuum_count = 0` for several big tables *since that reset*, not
ever. `pg_class.reltuples` says `pack_rips` holds **3.65M** rows in 95,894 pages ≈ 215 B/row — normal,
not bloat. The 12,642 in `n_live_tup` is inserts-since-reset.

### 3.6 Single-row PostgREST INSERTs on the two pack-sales indexers

| statement | calls | mean ms | total | reads |
|---|---|---|---|---|
| `INSERT INTO topshot_pack_sales_history(…)` | 101,431 | 1,072 | **30.2 h** | 100 GB |
| `INSERT INTO allday_pack_sales_history(…)` | 68,089 | 808 | **15.3 h** | 47 GB |

**45 CPU-hours and 147 GB across ~170k single-row inserts** in 10.75 days, driven by
`rpc-topshot-pack-sales-backfill` (`1-58/3`) and `rpc-allday-pack-sales-backfill` (`*/3`). A second of
DB time per row is the cost of round-tripping one row at a time through PostgREST. ⚠ Any batching here
must respect the recorded trap: **a batch `.insert()` is ALL-OR-NOTHING and `23505` on one row writes
none of the batch** — on a cursored indexer that is permanent loss.

---

## 4. What I would do, in order of GB recovered per line changed

**Updated 2026-08-22 after shipping item 1.** Items 3 and 4 are now DECISIONS NOT TO ACT, each with the
number that justifies it — this file's own rule is that a decision not to act is the one nobody re-checks,
and the tell is a cost stated with no number in it.

1. 🚨 **TRIED AND REVERTED — do not simply retry it.** `83075d67` made the tick warm only the stalest
   `WARM_BOARDS_PER_TICK = 2`; reverted in `3836b31b` ~30 minutes later. It looked good for three ticks
   (6/6 warms, durations 31s → 5.8s, ages laddering inside the ceiling) and then **504'd three consecutive
   ticks at the 60s lambda limit, refreshing nothing.** `panini-squeeze` is the slowest board AND a PAGED
   fetch (several statements, each able to run to the 30s wall), so it is permanently the stalest — which
   made stalest-first select it every tick and blow `maxDuration`. A 504 writes no snapshot and no
   `pipeline_runs` row, so it got staler and was selected again. ⚠ **Warming five in parallel was wasteful
   but BOUNDED** — panini failing fast did not block the other four, capping the tick at ~31s. Rotation
   removed the parallelism that was accidentally providing that cap. Full mechanism + the three
   requirements for re-landing are in today's ledger entry.

2. **Materialize the five hot board views — now unambiguously the FIRST thing to do.** ⚠ Item 1 failed
   because it RATIONED attempts at a board that cannot finish instead of making it finishable, and
   `panini_squeeze_board` cannot be made safe by scheduling while one warm needs several 30s-capable
   statements. They are `relkind = 'v'` and
   cost 52–95 MB and 11.5–16.7s *per call*, so even at 2 boards/tick they will keep dying at the 30s wall
   whenever the instance is busy. An MV refreshed on the boards' real change cadence removes the failure
   mode outright rather than rationing it.
3. ⛔ **Do NOT re-tune the timing-out pack-EV crons yet — they are a SYMPTOM.** Measured: their
   **successes take 113–178s and their failures pin at the wall** (`rpc-refresh-allday-pack-realized`:
   20 failures at 600.0–602.7s vs 7 successes averaging 113s). Bimodal, so the batch sizes are not
   obviously wrong — they blow up under contention. Re-tuning now is tuning against a confounded
   measurement. **Re-measure after the rotation has run a full day.**
4. ⛔ **`refresh_wmc_fmv_changed`'s `v_chunk` is NOT the lever, and that is now measured rather than
   assumed.** Inflow is only **4–144 distinct editions per 10 min**, and the UPDATE plan is healthy (nested
   loop + `idx_wmc_coll_ek_serial_cover`, no seq scan). The cost is **write amplification**:
   `wallet_moments_cache` carries **15 indexes** and `fmv_usd` sits in three of their predicates/INCLUDEs,
   so every fmv write is **non-HOT** across ~23,400 row updates per run. ⚠ **No index is droppable — all 15
   have non-zero `idx_scan`.** The real fix is schema or architecture (stop denormalising fmv into wmc):
   **Trevor's call, not a batch-size tweak.** *Separately real:* its temp build reads **66 MB / 3.58s to
   return 612 rows** off a **619× row misestimate** that picks an index whose `computed_at` is the second
   column. ~84 GB/window.
5. **The `sales` partition fan-out — callers IDENTIFIED, and the obvious fix is probably WRONG.**
   Scanning `pg_proc.prosrc` for `FROM public.sales`, the heavy readers carrying **no `sold_at` predicate**
   are `promote_unmapped_sales` (138 GB + 104 GB across two signatures), `resolve_sales_ingest_unresolved`,
   `claim_sales_counterparty_batch`, `backfill_nft_edition_map_from_sales` (67 GB, mean 188s, max 590s) and
   `fmv_backfill_candidates`. ⚠ **Do NOT just add a date predicate.** These are BACKFILLS over sales that
   were never mapped, and an unmapped sale can be arbitrarily old — that is the entire point of them, so a
   `sold_at > now() - N` filter would silently stop them ever reaching the tail they exist to drain. The
   lever is an **index supporting the unmapped predicate, or a cursor**, not partition pruning. Filed this
   way deliberately: the one-line version of this item is a correctness regression waiting to happen.
6. **Edition-page ISR may be over-revalidating (NEW, not in the original filing).**
   `app/(collections)/[collection]/edition/[slug]/page.tsx` is `revalidate = 600` over a ~100k-edition
   catalogue, driving `get_edition_recent_sales` at **476 calls/hour** and `get_edition_market_bundle` at
   **236/hour** — **201 GB (2.4%)**. Measured FMV inflow is 4–144 editions per 10 min, so the overwhelming
   majority of revalidations recompute unchanged data. ⚠ **Deliberately NOT filed as waste**: ask freshness
   moves faster than FMV, so this is a product/SEO decision, not a defect. Numbers given so it can be decided.
7. **`query_sql` (the Cowork artifact RPC) is 250 GB / 3.0%** at **56 calls/hour**, 2,560 ms mean — one every
   ~64s, continuously, for dashboards a human opens occasionally. Worth checking whether an artifact polls
   on a timer.

---

## 5. Durable lessons for CLAUDE.md / the reference docs

- ⚠ **`collections.is_active` is not an /insights launch switch.** `lib/launch-flags.ts` is the only
  authority on whether a public surface is live; route headers and gate comments go stale on a one-line
  flag flip and read as current forever. (Refutation #1 — I had an 8.4%-of-all-IO "finding" built on it.)
- ⚠ **`service_role` carries `statement_timeout = 30s` in `rolconfig`, and it BINDS on the
  `supabaseAdmin` path** — every board statement's `max_exec_time` is pinned at 29.4–29.9 s. This
  qualifies CLAUDE.md's "no Postgres timeout bounds a `supabaseAdmin` RPC": the 352 s observation stands
  for some paths, but the 30 s wall is real and is what these boards die on. **Read `rolconfig` for the
  role you are actually running as** before assuming a call is unbounded.
- ⚠ **A documented ceiling does not mean the code path you are looking at applies it.**
  `BOARD_LIVE_TIMEOUT_MS` is documented at length in `board-cache.ts`, and `warmBoard` — in the same
  file — never uses it. (Refutation #2.) **Read the call site, not the constant's docstring.**
- ⚠ **A failure rate is not a cost until you weight it by what a failure spends.** These boards fail
  *because* they are expensive, so the failing runs are the priciest ones in the population — the
  opposite of the usual "the failures were cheap, they bailed early" intuition.
- ⚠ **`n_live_tup` / `last_autovacuum` / `autovacuum_count` are all relative to the last stats-collector
  reset**, and a reset makes a healthy table look like a never-vacuumed 84%-dead one. Cross-check with
  `pg_class.reltuples` and `relpages` before filing bloat.

---

## 6. BEFORE-SNAPSHOT for measuring the rotation (captured 2026-08-22 20:41:45Z)

⚠ `pg_stat_statements` is CUMULATIVE since its 2026-08-12 01:33:59Z reset, so an "after" reading is
meaningless without this. **Diff against these numbers; do not compare against the percentages above.**

| counter | value at 20:41:45Z |
|---|---|
| `sum(shared_blks_read)`, all statements | **1,083,705,591** blocks = 8,269 GB |
| `sum(total_exec_time)`, all statements | **4,230,308** s |
| `sum(shared_blks_read)`, the 5 warm boards' views | **112,489,356** blocks = 858 GB |
| `panini_squeeze_board` calls | **5,293** |
| `dealloc` | **0** (population still complete) |

Rotation went live with `83075d67`. **Only ONE variable moved, so the delta is attributable** — which is
exactly why items 3 and 4 above are deliberately not being changed in the same window.

The check that matters is the per-board 48h fail rate:

```sql
SELECT b->>'key' AS board, count(*) AS ticks,
       count(*) FILTER (WHERE (b->>'ok')::boolean) AS warmed
FROM pipeline_runs pr, jsonb_array_elements(pr.extra->'boards') b
WHERE pr.pipeline='refresh-insights-cache' AND pr.started_at > now() - interval '48 hours'
GROUP BY 1;
```

⚠ **A tick now covers 2 boards, not 5.** Read `extra->'rotation'` (`warmed_keys` / `skipped_keys`)
alongside it, or a correct 2-of-5 tick reads as a coverage collapse — and the 48h window straddles the
change for two days, so rows on both sides of it are mixed.

---

## 7. The worst board view, measured to the arm (2026-08-22 ~21:40Z)

Follow-up after the rotation revert, since materialising these views became item 1. **Measure before
materialising: two of the three candidate fixes below are worse than they look.**

`cross_collection_deals_board` is a 3-way `UNION ALL` (Top Shot / Pinnacle / All Day). Its Top Shot arm,
`topshot_deals_vs_fmv`, measured **alone**:

```
Aggregate  Buffers: shared hit=20010 read=9136        -- 29,146 buffers = 228 MB
Execution Time: 10501 ms                              -- to return TWELVE rows
```

**85% of that is one node.** A per-edition latest-FMV subquery, `loops=6211`, `hit=19666 read=5178`
= **24,844 of the 29,146 buffers**:

```
->  Subquery Scan on lf (actual rows=0 loops=6211)
      Filter: confidence = ANY('{HIGH,MEDIUM}') AND fmv_usd > 0
      Rows Removed by Filter: 1
      ->  Limit -> Index Scan using fmv_snapshots_2026_collection_id_edition_id_computed_at_idx
```

⚠ **The confidence filter is applied AFTER the per-edition `LIMIT 1`.** So the view pays 6,211 index
descents to take each edition's single latest snapshot, and then discards most of them for failing the
filter — 6,211 lookups → 2,156 rows → **12 output rows**. This is the same lateral shape CLAUDE.md already
records for `compute_pack_ev_per_edition_weighted` (18,766 vs 1,046,192 buffers).

### The three fixes, and why two are traps

1. ⚠ **"Replace the lateral with a set-based `DISTINCT ON`" — DO NOT assume this wins.** It trades 6,211
   targeted descents (~4 buffers each) for a scan of the whole collection's slice of `fmv_snapshots_2026`
   (202 MB heap + a 90–116 MB index). That is plausibly MORE work, not less. It needs a warm-vs-warm
   buffers comparison before anyone writes it, not a rewrite on the strength of the pack-EV precedent.
2. ⚠ **"Add `confidence` to the covering index so the lookup goes index-only" — viable but MARGINAL, and I
   am filing the number that says so rather than the recommendation.** `fmv_snapshots_2026_coll_ed_ct_fmv_idx`
   already INCLUDEs `fmv_usd` but not `confidence`, so the planner picks the smaller plain index and visits
   the heap. ✅ Index-only is genuinely available here — **`fmv_snapshots_2026` is 99.8% all-visible**
   (`relallvisible` 25,765 / `relpages` 25,826), so the usual blocker does not apply. **But the saving is
   ~1 heap buffer of ~4 per loop — roughly 6,000 of 29,146 buffers, ~25%** — bought with permanent write
   amplification on the hottest partitioned table (13,835 edition writes/day), and `CREATE INDEX
   CONCURRENTLY` is reachable only via a one-statement pg_cron job. **Cost/benefit is genuinely close to
   even. Do not ship it as an "easy win".**
3. ✅ **Materialise it. 228 MB and 10.5s to produce 12 rows is not a query to tune, it is a query to
   precompute.** The output is tiny and changes slowly; the input is scanned in full every time. This is
   the one with an order-of-magnitude payoff, and it also removes the 30s-wall failure mode that the
   reverted rotation was trying to schedule around.

⚠ **A semantic subtlety for whoever writes it:** the arm's meaning is "the edition's LATEST snapshot must be
HIGH/MEDIUM", not "the edition has SOME recent HIGH/MEDIUM snapshot". Pre-filtering editions to those with a
qualifying snapshot would shrink the candidate set before the expensive step and looks like a free win — it
is a **different board**. Confirm which one is intended before changing the filter's position.

### Two dead ends from the same pass, recorded so nobody re-walks them

- ⚠ **The `count=exact` full-table scan on the pack-sales indexers (§3.6 sibling) is real and large but NOT
  safely fixable from here.** `allday_pack_sales_history` and `topshot_pack_sales_history` are each read with
  `pgrst_source_count AS (SELECT $3 FROM <table>)` — PostgREST's exact count, an unfiltered full scan on
  **every** request: 2,144 × 130 MB + 1,794 × 147 MB = **529 GB, 6.4% of all reads**, ~9s per call, every
  3 minutes. ⛔ **The two edge functions have NO SOURCE IN THE REPO** (deploy-only), and the deploy skill
  explicitly forbids hand-transcribing ingest functions ("a wrong digit will not crash — it silently
  mis-walks block ranges"). Needs an operator with the real source, not an agent session.
  ⚠ Those same queries are `SELECT * … LIMIT/OFFSET` with **no `ORDER BY`** — this repo's documented
  unstable-pagination ban. Worth checking for correctness, not just cost.
- ⚠ **"VACUUM so the count can go index-only" — REFUTED as a fix, and the refutation is the useful part.**
  The visibility map on those two tables is empty (`allday` **10 of 18,109 pages all-visible = 0.1%**,
  `topshot` 18.6%), which is exactly why the count seq-scans. My first hypothesis was a pinned xmin horizon.
  **Measured and false**: `idle_in_transaction = 0`, `max(age(backend_xmin)) = 273`, zero replication slots,
  zero prepared transactions. Nothing is holding the horizon; the VM is being re-dirtied by the indexers'
  own constant upsert traffic. A manual VACUUM would help for minutes and then decay, while adding IO to a
  saturated instance now. **Not worth doing.**
