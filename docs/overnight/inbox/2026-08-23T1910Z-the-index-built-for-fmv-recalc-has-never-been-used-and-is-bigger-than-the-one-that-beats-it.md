# The index built for `fmv-recalc` has never been used in 72 days — and it is BIGGER than the index that beats it

**Filed:** 2026-08-23 ~12:10 PT (19:10Z) · **By:** Claude Code, interactive · **Status:** MEASURED, nothing dropped
**Relates to:** R46 (working set) · `fmv-recalc` (72.7% wall-kills) · the Supabase performance advisor's 294 `unused_index` lints

🚨 **READ THE CORRECTION AT THE BOTTOM BEFORE ACTING ON JUDGEMENT 1.** The mechanism in the next section is
wrong and the conclusion inverts: the index must be REPAIRED, not dropped.

## The headline

| index on `sales_2026` | scans (72 d) | tuples read | size |
|---|---:|---:|---:|
| `sales_2026_collection_id_sold_at_idx` — **the one the planner picks** | **31,189** | 606,443,958 | **60 MB** |
| `idx_sales_2026_fmv_recalc_window` — **the one named for the job** | **0** | 0 | **98 MB** |

**It is 63% larger than the index that beats it, and it has never been scanned.**

## Why it can never be used, from the plan rather than from reasoning

```sql
CREATE INDEX idx_sales_2026_fmv_recalc_window ON public.sales_2026
  USING btree (sold_at DESC) INCLUDE (edition_id, collection_id)
  WHERE (price_usd > 0 AND edition_id IS NOT NULL);
```

`fmv_recalc_90d_catchup_editions` filters `collection_id = $1 AND sold_at >= now() - 90d AND price_usd > 0`.
The partial-index predicate matches exactly — but **`collection_id` is INCLUDEd, not a KEY**, so it cannot be a
search key. `EXPLAIN` on the real query:

```
->  Parallel Index Scan using sales_2026_collection_id_sold_at_idx on sales_2026
      Index Cond: ((collection_id = '95f28a17-…'::uuid) AND (sold_at >= (now() - '90 days')))
      Filter: (price_usd > '0'::numeric)
```

Both predicates land as an **Index Cond** on the `(collection_id, sold_at)` index. The `sold_at`-leading index
could only ever offer a range scan over 90 days of ALL collections, then filter — strictly worse. **The planner
is right and the index is dead by construction, not by chance.**

⚠ **The stats are decisive, not an artifact:** Postgres uptime **72 days**, `pg_stat_get_db_stat_reset_time` is
NULL (never reset), and **1,368,447,413 index scans** are recorded across the database (busiest single index:
179,630,089). `idx_scan = 0` here means never, not "not lately".

## The wider population, correctly scoped

- **1,212 indexes; 709 never scanned.** After excluding everything backing a PRIMARY KEY or UNIQUE constraint:
  **286 droppable, 325 MB, 2.4% of the 13 GB database.**
- ⚠ **This is NOT a lever on R46's measured problem.** R46 is **765 GB/day of READS re-reading a 6.5 GB hot
  set**. An index with `idx_scan = 0` contributes ~0 to read volume *by definition*. Saying "294 unused
  indexes!" next to a read-volume problem would be the tidy-hypothesis trap this repo keeps recording.
- **What they do cost is WRITE amplification, and it is CONCENTRATED — 2 indexes, not 286:**

| table | writes (72 d) | live rows | writes/row | unused index |
|---|---:|---:|---:|---|
| `topshot_pack_sales_history` | **11,596,123** | 586,535 | ~20 | `idx_ts_pack_sales_hist_block_time` (32 MB) |
| `allday_pack_sales_history` | **8,019,165** | 552,396 | ~15 | `idx_allday_pack_sales_hist_pack` (31 MB) |
| `sales_2026` | 195,009 | 1,018,967 | 0.2 | `idx_sales_2026_fmv_recalc_window` (98 MB) |
| `sales_2022` | **0** | **0** | — | 3 indexes, 15 MB on an EMPTY partition |

**19.6 M writes in 72 days each maintained an unused ~30 MB index.** That is the write lever; the 98 MB one is
the space lever; they are different arguments and should not be merged into one number.

## ⛔ Nothing dropped, deliberately

`DROP INDEX` is destructive DDL, and every `apply_migration` costs a **~10–20 s burst of user-facing
`PGRST002` 500s** (schema-cache re-introspection). Three separate judgements are owed and they are Trevor's:

1. **`idx_sales_2026_fmv_recalc_window`** — the strongest case: provably unusable by its own query, 98 MB,
   beaten by a smaller index. ⚠ Check the sibling partitions first (`sales_2025`, `sales_2027`…): if the
   index was created per-partition, the same reasoning applies to each.
2. **The two pack-sales-history indexes** — the write-amplification case.
3. **`sales_2022`'s three indexes on an empty partition** — free, but 15 MB is not worth a PGRST002 burst on
   its own; fold it into a batch if one is ever run.

⚠ **Batch them into ONE migration in a low-traffic window** rather than paying the burst three times.

⚠ **Re-measure before acting** — these figures are a dated sample, and a `DROP INDEX` is not reversible in the
cheap sense: rebuilding a 98 MB index on this instance is itself an IO event.

---

## ⚠ CORRECTION — 2026-08-23 ~14:30 PT. The numbers stand; the mechanism above is WRONG, and it inverts the conclusion.

**What was wrong.** The section "Why it can never be used, from the plan rather than from reasoning" EXPLAINs
`fmv_recalc_90d_catchup_editions` and concludes the index is "dead by construction" because `collection_id`
is INCLUDEd rather than a key. **I EXPLAINed the wrong function.** There are two `fmv_recalc_*` functions and
the index is named for the other one, `fmv_recalc_edition_page`, which does **not** filter
`collection_id = $1` — it filters `collection_id <> p_pinnacle_collection_id` over a `sold_at` window. For
*that* function the index matches the predicate **exactly**: leading key, partial predicate, covering columns.

**What is actually true.** The index is not dead by construction. It is **unreachable** — PostgreSQL 17
removes the query's `edition_id IS NOT NULL` qual because the column is declared NOT NULL, which makes the
index's own predicate unprovable, so the planner drops the index from the candidate set. Full evidence, four
controls and a causal manipulation:
[2026-08-23T2130Z — Postgres 17 makes partial indexes with `IS NOT NULL` predicates unreachable](2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md).

**Why the correction matters rather than being a footnote.** Judgement 1 above proposes **dropping** this
index as "provably unusable by its own query". Measured, the opposite holds: made reachable, it runs
`fmv_recalc_edition_page`'s window **2.9× faster on 2.0× fewer buffers**, and at the real 90-day window it
completes in ~16 s where the as-written form does not complete in 60 s. **Do not drop
`idx_sales_2026_fmv_recalc_window` — repair its predicate.**

**What is unaffected.** Everything measured rather than reasoned: the 0 scans / 98 MB / 72-day uptime figures,
the never-reset stats argument, the 1,212-index population, the write-amplification table, and judgements 2
and 3 (the two pack-sales-history indexes and the empty `sales_2022` partition). The reasoning defect was
confined to *which query I attributed the index to* — the repo's own rule, "read `cron.job.command` / the
function body to learn what a name calls; never infer the callee from the name", applied to an **index** name
and I did not apply it.

⚠ **And one more general lesson from it:** `idx_sales_2026_top_sales_board` has **502 recorded scans** and is
unreachable *today*. A non-zero `idx_scan` is a claim about the past. An unused-index sweep cannot see this
defect class on exactly the indexes that used to work.
