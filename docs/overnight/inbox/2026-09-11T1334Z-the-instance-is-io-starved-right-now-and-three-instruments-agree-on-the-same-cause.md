# The instance is IO-starved RIGHT NOW, three independent instruments agree, and a 3.25 GB table's near-continuous autovacuum is a prime consumer

**Filed 2026-09-11 06:34 PT (Claude Code, cloud) — Trevor: "Keep going."** Found while chasing why `offers-sweep` still 530s; the 530 turned out to be a smaller story than what the logs were sitting next to.

🚨 **READ [the 1330Z filing](2026-09-11T1330Z-a-live-saturation-spell-with-a-named-culprit-a-50000-row-batch-that-usually-takes-8-seconds.md) FIRST — IT NAMES THE CULPRIT AND THIS ONE DOES NOT.** A concurrent session snapshotted the SAME spell **20 minutes before** this one (13:25Z vs 13:45Z) and got further: **pg_cron jobid 355, `backfill_pinnacle_trade_acquisitions(50000)`, seven parallel workers, longest 191 s**, with the causal chain intact — heavy `DataFileRead` → disk IO saturated → **WAL writes stall** → 29 backends queued on `LWLock:WALWrite`. They also tie it to a **go-live bar**: M11 claimed *"~0 saturation spells since 08-30"* and the true count is **259 `job startup timeout` rows in 3 days against a bar of 0 in 7**.

⛔ **SO DO NOT READ THIS FILE AS "THE AUTOVACUUM IS THE CAUSE".** Their evidence for causation is stronger than anything here, and a batch size on a schedule we control is a far better lever than a vacuum we should not starve. What the two readings establish TOGETHER is that **at least two heavy IO consumers were running concurrently**: their batch job, and a 39-minute autovacuum that — by its own 2,344 s runtime — had already been running since ~06:06 PT and was therefore underneath THEIR snapshot too. ⭐ **The autovacuum is a co-occurring standing consumer, not the trigger.** This file's distinct contribution is that second consumer plus the DOWNSTREAM cost — the kill rates and the user-facing timeouts below — which their filing does not cover.

⚠ **READ THE SCOPE FIRST.** The kill rates and the log counts are WINDOWED (6 h). The `pg_stat_activity` reading is a **SNAPSHOT at 06:45 PT** and a snapshot is not a distribution — this file does NOT claim a trend, a start time, or a cause-and-effect chain. What it claims is that three instruments that fail in different ways all read the same thing at the same moment, which is why it is worth someone's next hour.

## The three readings

**1. Every active backend is blocked on IO — not CPU, not locks.** `pg_stat_activity` at 06:45 PT: **34 active** connections (`max_connections` 90, compute = SMALL, 2 cores). Every single one carries `wait_event_type = IO`, `wait_event` in (`DataFileRead`, `DataFilePrefetch`). ⭐ That is this repo's own standing claim — *"saturation is IO-, not CPU-bound"* — caught in the act rather than quoted.

**2. The longest running statement is an autovacuum, at 39 minutes.**
`autovacuum: VACUUM public.wallet_moments_cache` — `running_s = 2344`, waiting on `DataFileRead`. A second one (`ANALYZE public.panini_card_serials`, 53 s) was running concurrently.

| table | total size | live | dead | % dead | autovacuum_count | last completed (PT) |
|---|---|---|---|---|---|---|
| `wallet_moments_cache` | **3,250 MB** | 2,305,851 | 99,919 | **4.2 %** | **1,025** | 2026-09-11 04:59 |

⭐ **The tell is 1,025 passes at 4.2 % dead.** The last pass FINISHED at 04:59 PT and another was 39 minutes deep by 06:07 PT — i.e. it is vacuuming this table close to continuously, for a modest dead ratio, on the largest table in the database, against a **22 MB/s** tier budget. Whatever else is competing, this is a standing consumer.

**3. The lanes with the heaviest `after()` bodies are being killed at their wall, and the user-facing pages are timing out.** Heartbeat-vs-terminal correlation (the only instrument that sees a `maxDuration` kill — `try/catch` cannot catch one and `pipeline_runs_daily` never shows it), **6 h window**:

| lane | heartbeats | terminals | kills | rate |
|---|---|---|---|---|
| `panini-ingest` | 273 | 147 | **126** | **46 %** |
| `fmv-recalc` | 37 | 14 | **23** | **62 %** |
| `wallet-backfill` | 252 | 188 | 64 | 25 % |
| `drain-fmv-cold-tail` | 12 | 5 | 7 | 58 % |
| `wallet-backfill-golazos` | 254 | 242 | 12 | 5 % |

⚠ **One artifact stated so nobody over-reads the table:** a fixed window counts a heartbeat near its end whose terminal lands after the cutoff as a kill. At these volumes that is ~1–2 rows, not 126 — but it is why the small numbers (1s) are noise.

And the same window in Vercel production runtime logs, on **user-facing** paths:
- `/nba-top-shot/edition/271:9040::19` → status **0** (connection closed), `[edition] market_bundle canceling statement due to statement timeout`
- `/nfl-all-day/edition/6094` → status **0**, plus `get_edition_offers timed out after 45000ms — degrading to empty`
- `/nba-top-shot/player/robert-covington` → `get_player_detail timed out after 45000ms — failing OPEN`
- `/nfl-all-day/pack/dist/5815` → four `read exceeded 5000ms` on one page

⛔ **`failing OPEN` and `degrading to empty` are the honesty canon's own worst sub-classes firing in production.** They are behaving as designed — the point is how often the design is being exercised.

## What this is NOT

- ⛔ **Not attributed to the 1am night pass.** Its migrations landed 02:13–03:34 PT and this reading is 06:45 PT. Plausible, unproven, and **nobody should act on that link without the change-point split** (`pipeline_runs` retains ~73 h, so the split is available).
- ⛔ **Not "autovacuum is the bug".** Autovacuum on a 3.25 GB hot cache table is necessary; disabling or starving it trades a visible problem for a worse invisible one. The lever is per-table TUNING, not removal.
- ⛔ **Not an upgrade recommendation.** This repo's standing rule is *fix expensive queries, don't upgrade* — and no infra spend pre-revenue.

## The cheapest next measurements (none of them shipped here, on purpose)

1. **Split on a change point.** Kill rates per hour across 72 h. If 46 %/62 % are steady-state the fix is capacity planning; if they stepped, find the step. **A rate pooled across a change measures neither side.**
2. **Is `wallet_moments_cache` churn justified?** `n_tup_upd` / `n_tup_del` per hour vs `autovacuum_count`. If it is rewritten wholesale on a cadence, the lever is the WRITER, not the vacuum.
3. **Per-table autovacuum tuning as the candidate fix:** `autovacuum_vacuum_scale_factor` / `autovacuum_vacuum_threshold` on `wallet_moments_cache` so passes are fewer but still bounded. ⚠ This is a production change with DELAYED consequences (bloat accrues quietly) and needs a before/after on table size and dead-tuple ratio, not just on kill rate.
4. **`fmv-recalc` at 62 % deserves its own look** — this repo already records it as the DB's #1 reader and as *"wasteful, NOT broken, SIZED"*. A 62 % kill rate is new information against that filing and may or may not survive item 1.

## Why it was not shipped from here

Every candidate above is either a production DB-parameter change with delayed, hard-to-reverse effects, or needs a distribution this session did not take. **The measurement is the deliverable; the fix needs the change-point split first.**

## Incidental, and separately filed context

The thread that led here: `offers-sweep` and `topshot-deal-floor-serials` both last wrote **2026-08-28** and both now fail with **HTTP 530** from `public-api.nbatopshot.com/graphql` (reached via `topshot-proxy`, which passes the upstream status through verbatim — `index.js:115`). Register **#81** carries that. ⭐ **`sales-indexer` shares the dependency and does NOT lose data** — it degrades to on-chain tx-decode and `unmapped_sales` resolution ran **100 % on each of the last four full days**. That fallback is the difference between the two outcomes and is worth copying, not just noting.

---

# ADDENDUM (06:40 PT) — the 1330Z filing's ONE unexplained burst is explained, and its lever applies to THREE jobs, not one

The 1330Z filing closes with two honest loose ends. Both move here.

## 1. "09-10's 12Z burst (34 timeouts) has no slow run of 355 behind it" — it has the OTHER filed mechanism behind it

Every job that ran long inside 2026-09-10 12:00–13:00Z fires *inside that hour*, and they are almost all six-hourly:

| jobid | job | schedule | fires | max_s | failed |
|---|---|---|---|---:|---|
| 218 | `rpc-backfill-pinnacle-mint-acquisitions` | `19 */3 * * *` | 12:19 | **869** | ✗ |
| 210 | `rpc-refresh-allday-pack-sales-agg` | `20 */6 * * *` | 12:20 | **810** | ✗ |
| 62 | `rpc-remap-misattributed-sales` | `23 */6 * * *` | 12:23 | 623 | ok |
| 211 | `rpc-refresh-allday-pack-realized` | `35 */6 * * *` | 12:35 | 600 | ✗ |
| 65 | `rpc-allday-ev-corrected-refresh` | `47 */6 * * *` | 12:47 | 600 | ✗ |
| 324 | `rpc-thp-leg-impossible-parallel` | `48 0,6,12,18 * * *` | 12:48 | 600 | ✗ |
| 212 | `rpc-refresh-topshot-pack-sales-agg` | `50 */6 * * *` | 12:50 | 601 | ✗ |

⭐ **Four of them fail at 600–601 s, which is a CAP being hit, not a distribution** — the tell is that the numbers agree to the second.

**Measured, not inferred: there are 16 active six-hourly jobs** (`*/6` or `0,6,12,18`) **plus 2 three-hourly**, and they all converge on 0/6/12/18Z against `max_worker_processes = 6`. ⭐ **That is exactly the mechanism the 2026-09-09 filing describes and which the 1330Z filing correctly said was NOT the shape of the 13Z spell.** Both filings are right: **12Z is the convoy, 13Z is jobid 355's batch.** Two mechanisms, adjacent hours, and the 13Z spell landed on an instance the 12Z convoy had already left hot.

## 2. The `50000` lever is not one job — it is THREE, stacked six minutes apart

```
 78  rpc-backfill-pinnacle-acquisitions        [17 */6 * * *]
218  rpc-backfill-pinnacle-mint-acquisitions   [19 */3 * * *]
355  rpc-backfill-pinnacle-trade-acquisitions  [23 1-22/3 * * *]
```

All three carry the identical `(50000)` batch shape, and at 0/6/12/18Z **all three fire inside six minutes** — on top of the 16-job convoy. The 1330Z filing found 355 by catching it live; 218 is visible only in history, where it ran **869 s and FAILED** during the unexplained burst. ⛔ **Any batch-size change that fixes only 355 leaves two-thirds of the shape in place.**

⚠ **AND ALL THREE BACKFILL A COLLECTION THAT IS NOT LIVE.** `panini_blockchain` is the only `is_active = false` row in `collections`. That does not make the work worthless — it is catalog backfill for a future launch — but it is the cheapest thing to deprioritise on a saturated instance, and it is a **cadence** decision (three jobs, 0/6/12/18Z) before it is a batch-size one.

## What is still NOT established here

- ⛔ **Still no BUFFERS measurement**, so the 1330Z filing's first instruction stands unmet: cutting `50000` may not cut cost, because a `LIMIT` bounds output and not cost. **Do not change a batch size on the strength of this addendum.**
- ⛔ **The convoy is a schedule fact, not a proven cause** of the 34 timeouts — 16 heavy jobs in one hour against 6 worker slots is a strong mechanism, and the 600 s cap cluster corroborates it, but no change-point split was taken.
- ⚠ The 09-09 nine-hour spell had a different shape again. **This closes the 12Z door the 1330Z filing left open; it does not close the corridor.**

---

# ADDENDUM 2 (06:55 PT) — ⛔ CUTTING THE `50000` BATCH WOULD HAVE CHANGED NOTHING. Measured, safely, without executing the backfill.

The 1330Z filing's action #1 is *"cut the batch from 50,000 to 2,000–5,000"*, correctly gated on *"measure first: compare BUFFERS between batch sizes"* — and gated again on the instance being calm enough to measure, which it is not. **The measurement was available anyway: `EXPLAIN` WITHOUT `ANALYZE` does not execute**, so the SELECT half of `backfill_pinnacle_trade_acquisitions` can be planned at two batch sizes with no writes and no load.

**The plan is byte-identical at `LIMIT 50000` and `LIMIT 50`:**

```
Limit  (cost=37355.19..44226.26 rows=20 width=61)
  ->  Gather  (cost=37355.19..44226.26 rows=20)   Workers Planned: 1
        ->  Parallel Hash Join  (cost=36355.19..43224.26 rows=12)
              Hash Cond: ((t.nft_id = wmc.moment_id) AND (lower(t.to_wallet) = lower(wmc.wallet_address)))
              ->  Parallel Seq Scan on pinnacle_trade_events t  (cost=0.00..6018.00 rows=85100)
              ->  Parallel Hash  (cost=35855.39..35855.39 rows=33320)
                    ->  Parallel Index Scan using idx_wmc_collection_id on wallet_moments_cache wmc
```

⭐ **Two things in that plan kill the batch-size lever outright, and neither needed a stopwatch:**

1. **`rows=20`.** The planner estimates the join yields about **twenty** rows. A `LIMIT` of 50,000 is not merely large, it is **non-binding** — it can never be reached, so lowering it to 5,000, or to 50, removes nothing.
2. **Startup cost is 37,355 of 44,226 — 84%.** A `LIMIT` only trims the *run* cost after startup. Here almost all the cost is building the hash over `wallet_moments_cache` before a single row can be emitted, and that happens in full regardless of the limit.

⚠ **The byte-identical numbers are corroborated by the mechanism, not trusted on their own** — this repo's own warning is that an identical reading can be an artifact. Here the identity is the *predicted* consequence of a non-binding LIMIT over a blocking hash, and the plan states both facts independently.

## So what IS the lever

**The join predicate is unsargable, and I verified there is no index that could make it otherwise:**
`lower(wmc.wallet_address) = lower(t.to_wallet)` — a function on **both** sides. Measured: **zero expression indexes containing `lower(` on `wallet_moments_cache`, and zero on `pinnacle_trade_events`.** So the planner's only option is to hash one side whole. ⭐ **The expensive side is `wallet_moments_cache` — the same 3,250 MB table whose 39-minute autovacuum this filing opened with.** The two halves of this document meet at one table.

**And the function has no progress mechanism.** `LIMIT p_limit` carries **no `ORDER BY` and no cursor or watermark**, so every tick re-reads the same rows in physical order and relies on `ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING` to no-op. ⭐ **That is why it "usually takes 8 seconds" — it is normally doing nothing at all**, and the 490-second runs are what the same unbounded work costs when the instance is already hot. This is this repo's recorded "a queue walk that starts at the top of what it resolves COMPOUNDS", in a backfill rather than a queue.

**Candidate levers, in the order the evidence supports — none taken here:**

1. **Expression indexes** on `lower(wallet_address)` (`wallet_moments_cache`) and `lower(to_wallet)` (`pinnacle_trade_events`), making the join sargable. ⚠ An index on a 3.25 GB table is itself a large object and this instance is IO-bound — but `CREATE INDEX CONCURRENTLY` **does** run via `execute_sql` (proven 2026-09-09, 105 MB). **Verify with `EXPLAIN` that the planner would actually use it before building it.**
2. **A cursor/watermark** so the backfill advances instead of rescanning. With `rows=20` outstanding against 146,979 trade events and 3,742 acquisitions already written, most ticks are pure waste.
3. ⛔ **NOT a batch-size change.** Measured above, both directions.

⚠ **Scope: this is `backfill_pinnacle_trade_acquisitions` only.** Jobs **78** and **218** carry the same `(50000)` shape and were NOT planned here — check each before assuming the same conclusion, because the same argument can be binding in one function and decorative in another.
