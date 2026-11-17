# ⭐ SHIPPED — the PG17-unreachable index is repaired, and "reachability is per-index, only EXPLAIN settles it" is REPLACED by a decidable rule

**Filed:** 2026-08-25 ~23:20 PT (2026-08-26 06:20Z) · **By:** Claude (Cowork cloud), interactive
**Closes:** the repair half of [2026-08-23T1910Z](2026-08-23T1910Z-the-index-built-for-fmv-recalc-has-never-been-used-and-is-bigger-than-the-one-that-beats-it.md) and the "five unclassified" half of its 08-26 re-measurement · builds on [2026-08-23T2130Z](2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md)
**Also RETRACTS one judgement in the 1910Z filing.** See §4 — acting on it would have removed working indexes.

## 1. Shipped

`idx_sales_2026_fmv_recalc_window` rebuilt without the redundant `edition_id IS NOT NULL`
conjunct, via the one-off pg_cron `CREATE INDEX CONCURRENTLY` recipe. **05:34:01Z → 05:37:23Z,
202 s, `indisvalid = true`**, old index dropped concurrently, new one renamed to the documented
name. Role budget raised to 600 s for the window with a self-healing reset job armed *before*
the raise; `pg_roles.rolconfig` verified back to `search_path` only, active job count back to
its 99 baseline, zero `indisvalid = false` debris on the table.

**Measured on the UNMODIFIED production query** (no `fmv_recalc_edition_page` change, so no
DB-invariant pin moved):

| | plan node for the 90-day window on `sales_2026` | node cost |
|---|---|---|
| before | `Parallel Index Scan using sales_2026_collection_id_sold_at_idx` | 51,040.92 |
| after | `Parallel Index Only Scan using idx_sales_2026_fmv_recalc_window` | **15,264.74** |

`EXPLAIN (ANALYZE, BUFFERS)` after: **18,124 ms**, 84,667 buffers (79,249 hit / 5,418 read),
against the **50,471 ms** recorded in `database.md` for the as-written form — **~2.8x**, which
reproduces that filing's predicted 2.9x.

⚠ **THE BUFFER HALF OF THE PREDICTION DID NOT REPRODUCE, and the reason is named rather than
smoothed.** Predicted ~48,494 buffers; measured 84,667. `Heap Fetches: 82,082` is the entire
gap — an Index Only Scan falls back to the heap wherever the visibility map is unset, and
`relallvisible/relpages` was **31,355/37,671 (83.2%)**. A `VACUUM (INDEX_CLEANUP OFF, ANALYZE)`
took it to **33,388/37,671 (88.6%)**. ⛔ **Do not quote the buffer figure as final** until it is
re-measured after a full autovacuum cycle.

ⓘ **Early post-ship signal, offered as exactly what it is: n = 1.** The first production call
after the fix read **2,874 disk blocks** against a **31,564** lifetime average — but this repo's
own rule is that one sample is not a rate. **The honest post-ship metric is disk blocks per call
over ~24 h**, taken from `pg_stat_statements` deltas, and it has NOT been taken yet.

## 2. ⭐ The rule, which is the transferable half

The 08-26 re-measurement concluded: *"reachability is per-index and only an EXPLAIN on the real
query settles it. Neither grep nor `pg_stat_user_indexes` is a substitute."* **True, and it
stopped one step short.** There IS a decidable rule, and it explains all six cases:

> A partial index whose predicate contains `<col> IS NOT NULL`, where `<col>` is declared
> `NOT NULL`, is reachable **iff the query independently supplies something the planner can
> prove implies `<col> IS NOT NULL`** — a strict-operator clause on that column (`col = x`,
> `col <> x`, `col > x`), or an inner join on it. It is unreachable when the ONLY source of that
> qual was the query's own literal `col IS NOT NULL`, because PG17 constant-folds that away
> before predicate proving.

**Proven on a scratch table, both directions, and the negative control is the strong one:**

- predicate **with** the conjunct → **Seq Scan even under `enable_seqscan = off`** (the planner
  would rather do the thing it was told not to do than use the index)
- predicate **without** it → `Index Only Scan`, chosen with seqscan enabled

**All six of the shape sweep's indexes, now classified — 5 reachable, 1 not:**

| index | what supplies the proof | verdict |
|---|---|---|
| `pack_drop_pool_edition_idx` | `WHERE edition_id = $1` — strict equality | ✅ reachable (`Index Scan`) |
| `idx_sales_2026_top_sales_board` | `v_insights_top_sales` does `JOIN editions e ON e.id = s.edition_id` — an inner join derives the NOT NULL | ✅ reachable (`Bitmap Index Scan`) |
| `unmapped_sales_resolver_targets_idx` | the predicate's own sibling conjunct `nft_id <> ''` is strict | ✅ reachable (`Index Scan`) |
| `unmapped_sales_sold_at_unresolved_idx` | same | ✅ reachable (`Index Scan`) |
| `idx_pinnacle_editions_set_name` | `WHERE set_name = $1` | ✅ reachable (`Index Scan`) |
| **`idx_sales_2026_fmv_recalc_window`** | **nothing** — `GROUP BY edition_id` is not a strict clause | ❌ **unreachable — repaired** |

⭐ **This is why the predicate shape was never the selector.** It is not that the shape is a bad
proxy; it is that the shape describes the INDEX and reachability is a property of the
**query/index pair**. The rule above makes it decidable by reading the query, without an EXPLAIN
per index — though an EXPLAIN remains the confirmation.

## 3. ⚠ The 1910Z filing's closing lesson is REFUTED on its own worked example

It says: *"`idx_sales_2026_top_sales_board` has 502 recorded scans and is unreachable today. A
non-zero `idx_scan` is a claim about the past."*

**Measured: it is reachable today.** `EXPLAIN` on the real `v_insights_top_sales` query picks it
as a `Bitmap Index Scan`. The general caution — a cumulative counter is a claim about the past —
**stands and is good**; it was simply attached to an index that does not exemplify it.

⭐ **And a live delta settles the instrument question the filing left open.** Over one 4-minute
window: `pack_drop_pool_edition_idx` **420,894 → 420,898** (moving) while
`idx_sales_2026_fmv_recalc_window` held **flat at 3**. Same instrument, same window, opposite
answers — a **paired** delta does establish current reachability, where a cumulative total
cannot. That is the cheap test the filing wanted and did not have.

## 4. 🚨 RETRACTION — "`sales_2022`'s three indexes on an EMPTY partition" is FALSE

Judgement 3 of the 1910Z filing proposes dropping indexes on `sales_2022` as *"free"* because
the partition is empty. Its evidence was `n_live_tup = 0`.

**`SELECT count(*) FROM sales_2022` returns 750,702 rows**, `sold_at` spanning 2022-01-01 to
2022-12-31. The partition is fully populated. `n_live_tup` reads 0 because that column is a
statistics estimate and this partition has `n_tup_ins/upd/del = 0` and **`last_autoanalyze IS
NULL`** — it has never been analyzed, so the estimate was never set. A never-written partition
therefore reports itself as empty.

⛔ **Acting on it would have been destructive:** those indexes are among the busiest on the
instance — `sales_2022_nft_id_idx` **35,008,553 scans**, `idx_sales_2022_serial1` **4,656,921**,
`sales_2022_edition_id_sold_at_idx` **2,392,348**. The table's own `idx_scan` total is
**43,815,424** against `seq_scan` 669.

⭐ **The durable lesson, and it is this repo's own null-instrument class applied to a new
column:** **`n_live_tup` is an ESTIMATE, not a count, and on a never-analyzed relation it reads
0 — indistinguishable from empty.** Any emptiness claim must come from `count(*)`, or at minimum
be corroborated by `pg_relation_size` (`sales_2022_tx_nft_sold_idx` alone is **78 MB**, which no
empty table can produce). Judgements 1 and 2 of that filing are unaffected.

## 5. Left open, deliberately

- **The visibility-map shortfall** (§1) — re-measure `Heap Fetches` after autovacuum settles.
- **The 24 h post-ship rate** for `fmv_recalc_edition_page` — the falsifier, not yet run.
- ⚠ **`fmv_recalc_edition_page` still pages with `LIMIT/OFFSET`** over a full `GROUP BY` of
  `sales`. The index makes each page cheaper; it does not make the paging cheaper. That remains
  the larger fix and it is push-gated (the function carries a DB-invariant pin at
  `supabase/tests/fmv_recalc_edition_page.sql`).
