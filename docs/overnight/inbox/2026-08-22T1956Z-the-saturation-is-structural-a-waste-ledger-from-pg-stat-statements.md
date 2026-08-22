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

### 3.2 The failure telemetry added to answer "why" is recording NULL

`warmBoard` returns `error: res.error`, and the 2026-08-12 header in `board-cache.ts` says this was added
precisely because "a board failing 84% of the time produced telemetry that said only that it failed."
Over the trailing 24 h, **every failed board row has `error` = NULL** (panini 195, deals 188, first-mint
145, rookies 58, candy 36). The board fetchers are not populating `res.error`, so the fix landed on the
carrier and never on the source. **The instrument built to explain this class is silent about it** —
the repo's own "ask what a passing guard is structurally silent about", one level down.

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

Each of these is a **decision**, not a diagnosis — none is shipped, and 3.6 in particular has a recorded
data-loss trap in front of it.

1. **Drop `refresh-insights-cache` from `*/5` toward the boards' real completion rate**, or split the
   watchlist so `deals` / `first-mint` / `panini-squeeze` warm on a slower lane than `rookies` /
   `candy-mlb`. Today 3 of 5 boards pay full IO 288×/day to store nothing 57–76% of the time.
2. **Materialize the five hot board views.** They are `relkind = 'v'` and cost 52–95 MB *per call*.
   An MV refreshed on the boards' real change cadence turns ~810 GB/window into a rounding error, and
   removes the 30s-wall failure mode entirely. This is the largest single lever.
3. **Fix the NULL `error` in the warm telemetry (3.2) before tuning anything above it** — right now
   there is no instrument that can say whether a warm died at the 30s wall or failed for another reason,
   so any cadence change would be evaluated blind.
4. **Re-tune the always-failing cron batch sizes (3.3)** — `rpc-thin-sale-ask-disclosure-refresh` (100%)
   and `rpc-refresh-allday-pack-realized` (74%) do ten minutes of work per attempt and land none of it.
   Shrink the batch to fit the timeout; do not raise the timeout on a saturated instance.
5. **Re-measure `refresh_wmc_fmv_changed`'s `v_chunk` against the pg_cron caller's real budget (3.4).**
   Biggest single consumer in the database. Compare **buffers**, warm-vs-warm, at a quiet hour.
6. **Find the `sales` caller with no `sold_at` predicate (3.5).** Restoring partition pruning is a
   predicate, not a rewrite.

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
