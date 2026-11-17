# Postgres 17 makes a partial index UNREACHABLE when its predicate says `col IS NOT NULL` and the column is declared `NOT NULL` — and one of them is the 98 MB index `fmv-recalc` needs

**Filed:** 2026-08-23 ~14:30 PT (21:30Z) · **By:** Claude Code, interactive · **Status:** MEASURED with four controls and one causal manipulation. Nothing shipped — the repair is DDL on the FMV path.
**Supersedes the mechanism in:** [2026-08-23T1910Z — the index built for fmv-recalc has never been used](2026-08-23T1910Z-the-index-built-for-fmv-recalc-has-never-been-used-and-is-bigger-than-the-one-that-beats-it.md) (its *numbers* stand; its *explanation* was wrong — see the correction appended to that file)
**Bears directly on:** [2026-08-23T2000Z — `fmv-recalc` is NOT wedged mid-catalogue, page 0 can no longer COMPLETE](2026-08-23T2000Z-fmv-recalc-is-not-wedged-mid-catalogue-page-0-can-no-longer-complete.md)

## The rule, stated so it can be checked

This database is **PostgreSQL 17.6**. PG 17 drops a `col IS NOT NULL` qual from a query when `col` is
declared `NOT NULL` — the qual is redundant, so removing it is correct *as a filter*. But the removal happens
**before** partial-index predicate proving, and the prover works on clauses, not on column constraints. So a
partial index whose predicate carries that same conjunct can no longer be proven applicable, and the planner
**drops it from the candidate set entirely**. It is not out-costed. It is invisible.

The index becomes reachable again only if the query happens to supply some other **strict** clause on that
column (`col = $1`, `col <> $1`, …), because a strict operator clause does prove `col IS NOT NULL`.

## Evidence — four controls in both directions, plus a causal manipulation

**Negative (unreachable).** `idx_sales_2026_top_sales_board` — `btree (sold_at DESC) WHERE price_usd >= 100
AND edition_id IS NOT NULL`, 384 kB, and `sales_2026.edition_id` is `attnotnull = true`:

```
-- WHERE price_usd >= 100 AND edition_id IS NOT NULL ORDER BY sold_at DESC LIMIT 10
Bitmap Heap Scan on sales_2026  (cost=15475.17..27849.93)   <-- 384 kB ordered index ignored
```

**Causal manipulation — the only change is a redundant extra qual on the same column:**

```
-- … AND edition_id <> '00000000-0000-0000-0000-000000000000'::uuid
Index Scan using idx_sales_2026_top_sales_board  (cost=0.29..9.75)
```

**28,149 → 9.75.** Nothing else moved: same table, same window, same statistics, same session.

**Positive control 1 — same predicate shape, NULLABLE column.** `sales_2026_tx_nft_sold_idx`
(`WHERE transaction_hash IS NOT NULL`; the column is nullable) is chosen instantly:
`Index Only Scan … (cost=0.55..0.95)`. The qual is not removed, so the proof succeeds.

**Positive control 2 — NOT NULL column, but the predicate carries a strict clause too.**
`unmapped_sales_sold_at_unresolved_idx` (`resolved_at IS NULL AND nft_id IS NOT NULL AND nft_id <> ''`,
`nft_id` is NOT NULL) is chosen with **no residual filter** — `nft_id <> ''` supplies the proof.

**Positive control 3 — same index, both directions.** `pack_drop_pool_edition_idx`
(`WHERE edition_id IS NOT NULL`, column NOT NULL): a bare `WHERE edition_id IS NOT NULL` seq-scans; a
`WHERE edition_id = $1` uses the index. One index, one session, opposite outcomes from the qual alone.

**Positive control 4 — no `IS NOT NULL` conjunct at all.** `idx_sales_2026_ts_otherserial_cover`
(`WHERE serial_number > 1 AND price_usd > 0`) is chosen as an index-only scan with no filter — so
`price_usd > 0` proves fine and is not the blocker.

## The cost of it, on the one index that matters

`idx_sales_2026_fmv_recalc_window` — `btree (sold_at DESC) INCLUDE (edition_id, collection_id)
WHERE price_usd > 0 AND edition_id IS NOT NULL`, **98 MB, `idx_scan = 0` in 72 days** — is the index built
for `fmv_recalc_edition_page`, whose body is:

```sql
SELECT s.edition_id FROM sales s
WHERE s.sold_at >= p_window_start AND s.price_usd > 0
  AND s.collection_id <> p_pinnacle_collection_id AND s.edition_id IS NOT NULL
GROUP BY s.edition_id ORDER BY MAX(s.sold_at) DESC NULLS LAST
LIMIT p_limit OFFSET p_offset
```

The index matches that predicate **exactly** — leading key, partial predicate, covering columns. It has never
been used, for the reason above. Measured on `sales_2026`, same instrument, same window, same output rows,
both plans non-parallel:

| 30-day window, `LIMIT 500` | execution | buffers | plan |
|---|---:|---:|---|
| as the function writes it | **50,471 ms** | **97,669** | Index Scan using `sales_2026_collection_id_sold_at_idx` |
| + one redundant `edition_id <> '000…'::uuid` | **17,425 ms** | **48,494** | **Index Only Scan using `idx_sales_2026_fmv_recalc_window`** |
| | **2.9× faster** | **2.0× fewer** | 128,534 rows out of both |

At the function's real **90-day** window the gap is larger and one-sided: the as-written form **exceeded 60 s
twice** (the MCP ceiling — it did not complete), while the reachable form returned in **15,850 ms warm /
17,897 ms cold**. That is the same page-0 stall the 2000Z filing measured: `fmv_recalc_edition_page(90d, …,
500, 0)` at 25.4 s cold / 10.4 s warm, and page 0 + its first sales page past 55 s.

⚠ **The estimate over-promises and the reason is worth keeping.** The planner costs the reachable plan at
**14,864 vs 109,306 (7.4×)**, but the measured gain is 2.9×, because the index-only scan still does
**46,625 heap fetches** — `sales_2026` is 99.7% all-visible *overall*, but the last 90 days are the part
autovacuum has not caught up on, and that is exactly the range this query reads. A more aggressive
`autovacuum_vacuum_scale_factor` on `sales_2026` would compound with the fix; measure, do not assume.

## The repair, and why it is not shipped here

The conjunct `edition_id IS NOT NULL` in that index's predicate **excludes zero rows** — the column is
declared NOT NULL. It buys nothing and costs the whole index. The repair is to rebuild the index without it:

```sql
CREATE INDEX CONCURRENTLY idx_sales_2026_fmv_recalc_window_v2 ON public.sales_2026
  USING btree (sold_at DESC) INCLUDE (edition_id, collection_id)
  WHERE (price_usd > 0);
DROP INDEX CONCURRENTLY idx_sales_2026_fmv_recalc_window;
```

⛔ **Not shipped, deliberately, on four counts:**

1. It is **DDL on the FMV path**, which the autonomous rules put off-limits and which R52 already parked with Trevor.
2. `CREATE INDEX CONCURRENTLY` is reachable here **only via a one-statement pg_cron job** (libpq), never `execute_sql`; the non-concurrent form takes an `ACCESS EXCLUSIVE` lock on a 1 M-row hot table.
3. Every `apply_migration` costs a **~10–20 s burst of user-facing `PGRST002` 500s**.
4. Building a second 98 MB index on a disk-IO-budget instance is itself an IO event, and R46 says the budget is the constraint.

⚠ **A cheaper variant exists and should be considered first, because it needs no DDL at all:** add
`AND s.edition_id <> '00000000-0000-0000-0000-000000000000'::uuid` to `fmv_recalc_edition_page`. That is
`CREATE OR REPLACE FUNCTION` rather than an index rebuild — but it is FMV route logic, it encodes a planner
quirk in a query body where the next reader will not understand it, and it would need a comment that outlives
the PG version. **Prefer fixing the index; note the workaround so the choice is informed.**

## The rest of the population, enumerated rather than estimated

Six partial indexes in `public` carry an `IS NOT NULL` conjunct on a column declared NOT NULL:

| index | size | scans (72 d) | reachable today? |
|---|---:|---:|---|
| `idx_sales_2026_fmv_recalc_window` | 98 MB | **0** | **NO** — measured above |
| `unmapped_sales_resolver_targets_idx` | 9352 kB | 21,596 | yes — `nft_id <> ''` proves it |
| `unmapped_sales_sold_at_unresolved_idx` | 4512 kB | 1 | yes — same |
| `pack_drop_pool_edition_idx` | 2496 kB | 358,330 | yes **when** the query supplies `edition_id = $1` |
| `idx_sales_2026_top_sales_board` | 384 kB | 502 | **NO** — measured above; the 502 are historical |
| `idx_pinnacle_editions_set_name` | 48 kB | **0** | **NO** — measured; the prediction held |

The sixth was predicted unreachable from the rule and then measured, which is the only reason it counts:
`SELECT set_name FROM pinnacle_editions WHERE set_name IS NOT NULL ORDER BY set_name LIMIT 5` — the exact
query the index was built for — plans as a **Seq Scan + Sort** (cost 59.74). Tiny index, no practical cost,
but **3 of 6 is the population, not 2 of 6**, and the rule made a falsifiable prediction before the check.

⚠ **`idx_sales_2026_top_sales_board` is the quiet one.** It has 502 recorded scans, so every "unused index"
sweep passes it by — and it is unreachable *now*. **A non-zero `idx_scan` is a claim about the past, not
about the current plan.** That is the general lesson: this defect class is invisible to the unused-index
advisor precisely on the indexes that used to work.

## What is worth building

A DB-invariant pin: **no partial index may carry a `col IS NOT NULL` conjunct on a column declared NOT NULL.**
It is a one-query check (`pg_index.indpred` × `pg_attribute.attnotnull`), it has an exact current population
of 6 so it can be ratcheted, and unlike the unused-index advisor it fires on `top_sales_board` too. ⚠ It must
be satisfiable at a population of zero, and it must be a **ban at zero** rather than an allowlist of the six.

## ⚠ The load condition at measurement time, stated rather than assumed

Positive control taken at **2026-08-23 20:01:56Z**, minutes after the A/B: `active=6 · io_wait=4 · total=34 ·
longest active query 297 s`. That is **milder than the spell the daytime monitor controlled at ~18:10Z**
(`io_wait=12 / active=11 / total=46`) but it is **not a quiet instance**, and I am not claiming it was.

Two things keep the conclusion standing anyway, and they should be the reason it is believed:

1. **The two arms ran back to back, minutes apart, in the same session** — whatever the load was, both paid it.
2. **The decisive figure is BUFFERS, not milliseconds.** 97,669 → 48,494 on identical output rows is a
   property of the plan; disk-IO saturation cannot move it in either direction. The wall-clock ratio (2.9×)
   is the softer number and should be re-taken in a controlled quiet window before it is quoted.

⚠ **Re-measure before acting** — every number here is a dated sample. Compare **buffers**, warm against warm,
and take a `pg_stat_activity` positive control in the same minute as the measurement, not an hour later.
