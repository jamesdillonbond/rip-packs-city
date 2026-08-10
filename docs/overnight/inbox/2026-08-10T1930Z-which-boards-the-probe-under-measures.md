# Queued — the 17 boards the liveness probe under-measures, ranked; plus two corrections

Cowork cloud session, 2026-08-10 ~12:30 PT. **Read-only, planner-only. Nothing applied.**
Written to de-risk the queued *"did not change the shared probe — it would flip an unknown number of
the 45 boards red at once"* item. **It is no longer unknown.**

---

## ✅ DRAINED + ⛔ THREE CORRECTIONS (Claude Code, 2026-08-10 ~16:40 PT) — shipped as `20260810233442`

**The premise is CONFIRMED and the item is now SHIPPED** (migration
`audit_20260810_board_liveness_honest_sweep_decoupled` + pg_cron jobid 288
`rpc-public-board-liveness-sweep`, `28 */6`). But three load-bearing claims below did not survive
being measured, and a fourth defect turned up that nothing had noticed.

**⛔ 1. The candidate fix this file endorses DOES NOT WORK.** `SELECT count(*) FROM (SELECT * FROM v) t`
measures **3,873.09** on `allday_scarcity_board` — **byte-identical to the bare `count(*)`**, because PG
flattens the subquery and prunes exactly as before. An `OFFSET 0` optimization fence also fails
(**3,873.98**): the fence stops flattening, but PG still strips subquery output columns the outer
aggregate never references. **Shipping the filed one-liner would have changed nothing while looking
like a fix.** The form that works is a whole-row reference — `SELECT count(*), count(t.*)` → **42,827.12**
against an honest `SELECT *` of 42,826.00. Both aggregates are needed: `count(*)` keeps the row count
exact (`count(t.*)` alone undercounts an all-NULL row, since `ROW(NULL,NULL) IS NULL` is TRUE), and
`count(t.*)` is what holds the joins in the plan.

**⛔ 2. The planner-cost ranking does NOT predict runtime — the table below is not usable as an
ordering.** Measured honest wall-clock for 13 of the 17: the **two largest ratios in the table are
runtime non-events** — `panini_sale_feed_status` (441,780×) is **97 ms**, and
`cross_collection_cohort_stats` (355×) is **33 ms**, *faster* than its own 72 ms pruned reading. Meanwhile
a mid-table 1,134× (`candy_pack_ev_model`) is **94,508 ms** — the worst board on the estate. Cost ratio
measures how much *estimated* work was pruned, which is dominated by row-count estimates and join
shape, not by IO. The file's own "treat the ranking as ordering, not magnitude" caveat is too generous:
**the ordering is wrong too.** Rank this work by measured ms only.

**⛔ 3. "Fix the metric, then expect these 17 to move" understates the blocker.** The honest sweep is
far more expensive than the pruned one, and Leg 8 is the **last** leg of a single 600 s transaction
already killed at 600.0 s on 08-09 and 08-10 12:58Z. Dropping the honest probe into it would have made
that kill routine — **strictly worse than the blindness it fixes.** So the ship decouples first: a new
`public_board_liveness_sweep()` runs the honest sweep on its own job/transaction, and
`public_board_liveness_probe()` keeps its exact signature but becomes a cheap READ of the state table,
taking **Leg 8 from ~86 s to ~0 ms with zero edits to the 18-metric function**.

**🆕 4. NEW — the probe's per-board `statement_timeout` guard was INERT, and its comment said otherwise.**
`candy_pack_ev_model` ran **94,508 ms under a 5,000 ms cap**. The timer is armed at top-level-statement
start; a runtime SET inside a function cannot re-arm it. And had it fired, the cancel poisons the
surrounding transaction, so the sweep would die rather than degrade. This falsifies the 1700Z file's
*"the probe already has both a budget-exhaustion EXIT and a per-probe statement_timeout, so it does
degrade by design"* — only the EXIT was real, and it cannot preempt a single long board.

**Measured honest vs pruned (ms) — the boards that actually flip.** Expect `public_board_slow_count`
**5 → ~11**, all true positives:

| board | honest | pruned | budget | verdict |
|---|---|---|---|---|
| `candy_pack_ev_model` | **94,508** | 13 | 3,000 | BREACH 31× |
| `candy_pack_market` | **19,297** | 125 | 3,000 | BREACH 6.4× |
| `allday_scarcity_board` | ~15,172 | 120 | 8,300 | BREACH 1.8× |
| `topshot_2025_rookie_cohort_stats` | **7,283** | 5 | 3,000 | BREACH 2.4× |
| `candy_secondary_board` | **6,549** | 8 | 3,000 | BREACH 2.2× |
| `panini_squeeze_board` | >60,000 | — | 6,000 | BREACH (exceeded a 60 s probe) |
| `candy_offer_spread_board` | 2,557 | 1,073 | 3,000 | ok |
| `candy_player_board` | 1,838 | 6 | 3,000 | ok |
| `candy_parallel_premium` | 1,705 | 6 | 3,000 | ok |
| `candy_scarcity_board` | 1,342 | 6 | 3,000 | ok |
| `v_topshot_pack_market` | 707 | 34 | 3,000 | ok |
| `topshot_2025_rookie_index` | 582 | 2 | 3,000 | ok |
| `topshot_offer_ask_spread` | 347 | 201 | 3,000 | ok |
| `panini_sale_feed_status` | 97 | 31 | 3,000 | ok |
| `cross_collection_cohort_stats` | 33 | 72 | 3,000 | ok |

ⓘ Measured sequentially, so later boards benefit from earlier ones' cache warming —
`candy_pack_ev_model` paid the cold cost for the shared candy data. Treat these as one honest sweep's
worth of numbers, not as isolated per-board constants. `panini_coverage_summary` and
`pinnacle_scarcity_board` were not reached before the session budget ran out.

✅ **Corrections 1 and 2 of the original file (below) are both ACCEPTED as written** — the one-off
pg_cron CIC route is real, and precompute beats an index for `topshot_first_mint_trophy_stats`. Its
"retire the index framing, drop the operator gate" recommendation stands and remains queued.

---

## The measurement

For every active board in `public_board_liveness_watchlist`, plan `SELECT *` and plan
`SELECT count(*)` and compare total planner cost. Where `count(*)` is materially cheaper, the planner
is **removing work the probe therefore never times** — the exact mechanism that blinded
`allday_scarcity_board` after its `DISTINCT ON` fix.

Planning only, no execution, no IO. `EXPLAIN (FORMAT JSON)` in a `DO` loop, per-board exception
handler. **28 of 45 boards came back under 1.5× (probe roughly honest). These 17 did not:**

| board | `SELECT *` | `count(*)` | ratio |
|---|---|---|---|
| `panini_sale_feed_status` | 17,671.22 | **0.04** | **441,780×** |
| `candy_player_board` | 68,854.64 | 60.07 | **1,146×** |
| `candy_pack_ev_model` | 65,461.48 | 57.74 | **1,134×** |
| `candy_parallel_premium` | 65,459.88 | 57.89 | **1,131×** |
| `cross_collection_cohort_stats` | 10.64 | 0.03 | 355× |
| `candy_scarcity_board` | 69,468.74 | 927.18 | 75× |
| `v_topshot_pack_market` | 5,087.17 | 70.92 | 72× |
| `candy_pack_market` | 66,904.35 | 1,161.37 | 58× |
| `candy_secondary_board` | 7,019.47 | 168.90 | 42× |
| `topshot_2025_rookie_index` | 9,666.50 | 264.19 | 37× |
| `topshot_2025_rookie_cohort_stats` | 9,444.48 | 264.17 | 36× |
| `candy_offer_spread_board` | 67,841.64 | 2,311.38 | 29× |
| `panini_squeeze_board` | 145,207.04 | 6,319.41 | 23× |
| `allday_scarcity_board` | 42,638.16 | 3,872.65 | 11× |
| `panini_coverage_summary` | 38,947.63 | 5,946.61 | 6.5× |
| `pinnacle_scarcity_board` | 1,355.68 | 670.38 | 2.0× |
| `topshot_offer_ask_spread` | 3,872.02 | 2,625.25 | 1.5× |

## How to read this — two things it does NOT say

⚠ **It does not say these boards are slow.** It says the probe **cannot tell you**. Those are
different claims and conflating them is the error I made twice today.

⚠ **The ratio is a planner-cost ratio, not a runtime ratio — and it is a LOWER bound.** Planner cost
does not model cache-miss penalty, so an IO-bound board is understated further still. Measured:
`allday_scarcity_board` shows **11×** here but **72 ms vs ~15,172 ms (~200×)** in wall-clock, because
its heavy node reads ~249 MB at ~86% miss. **Treat the ranking as ordering, not magnitude.**

ⓘ **Why the honest ones are honest:** an ungrouped-aggregate view (e.g.
`topshot_first_mint_trophy_stats`) cannot be pruned — the aggregate must run to produce its single
row, so `count(*)` retains the full plan (54,793 vs 54,806, ratio 1.0). Row-producing views with
provably-unique joins are the prunable ones. **This is determinable per board from the plan, which is
what makes the probe fix scopable instead of blind.**

**Suggested order for the probe change:** fix the metric, then expect *these 17* to be the ones whose
readings move — largest ratio first. Anything outside this list moving is a surprise worth
investigating. And per the existing note, the **slow-vs-empty conflation must land in the same
change** or the honest measurement gets a misleading label.

---

## ⛔ Correction 1 — `topshot_first_mint_trophy_stats` is NOT operator-gated

The queued item says it *"needs `CREATE INDEX CONCURRENTLY`, which can't run via MCP —
operator-gated."* **That premise is false and was disproved on 2026-08-09.** A **one-off pg_cron job**
runs its command over a fresh libpq connection outside any transaction block, so `CIC` works there
with no client cap. Six `idx_sales_20xx_serial1` indexes were built that way, zero invalid. Recipe
and guardrails: memory `pgcron-oneoff-runs-concurrently-ddl`. (Budget caveat: pg_cron as `postgres`
inherits the global 120 s, which is not enough for the CIC wait phase — raise the role budget for the
window and **schedule the revert before making the change**.)

## ⛔ Correction 2 — but an index is probably the wrong fix anyway

`EXPLAIN (ANALYZE, BUFFERS)` on the real view, just now: **Execution 1,378.7 ms — 26 % of its
5,400 ms budget.** It is not slow right now; its breaches are IO-variance.

The cost is one node: `Parallel Seq Scan on sales_2026` for the "average price of other serials" leg,
**`Buffers: shared hit=2,712 read=31,859`** — ~249 MB read at an **86 % cache-miss rate**, against a
512 MB `shared_buffers`.

- **As a filter, an index is useless**: the predicate (`serial_number > 1 AND price_usd > 0 AND
  collection = TS AND sold_at >= 180d`) passes ~82 % of the partition — 661 k rows examined,
  144 k removed. An index scan would touch the same pages plus overhead.
- **As a covering structure it could work** — the node only needs `edition_id` and `price_usd`, so an
  index-only scan would replace a wide-heap read. ⚠ But that means a new index on the **hot** 2026
  partition; weigh against the wmc write-amplification finding (INCLUDE columns and partial
  predicates block HOT exactly like keys).
- **Precompute is the better lever.** The `o` leg is a per-edition 180-day aggregate that moves
  slowly — an MV on a cron removes the work rather than making it cheaper, which is the recorded
  preference for this class. ⚠ And per the standing rule, it must **not** be keyed on business date;
  backfills mutate the past.

**Recommendation: retire the "index it" framing; queue it as precompute, and drop the operator gate.**
