# ⭐ SHIPPED — one leading-wildcard `LIKE` was seq-scanning 88,086 rows 4,684 times per refresh, and it cost 13,000 worker-seconds a day

**Filed:** 2026-08-23 22:10Z (15:10 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** SHIPPED, verified, post-ship watch scheduled for 23:00Z.

## Why I looked here at all

The 2026-08-22 ledger entry that materialised three boards ends with an explicit, dated instruction:

> ⚠ Sample is small (1–3 refreshes each) and panini's two runs were 9.9 s and 68.2 s — **re-derive after a day** before quoting these.

A day had passed and nobody had. ⚠ **And the 08-21 filing that says the deals board fails ~78% of refreshes is SUPERSEDED** — that board was materialised on 08-22 and now answers in 1.98 ms. I nearly re-derived a fixed problem; the ledger grep is what stopped it.

## What the re-derive found

`jobid 353 rpc-refresh-panini-squeeze`, last 24 h — **the second-largest cron consumer on the instance**:

| metric | value |
|---|---|
| runs | 48 |
| **failed** | **9 (18.75%)** |
| avg | 271.7 s |
| max | 618.0 s |
| **worker-seconds/day** | **13,040 (3.6 h)** |
| wasted on failed runs | 3,679 s |

To rebuild a materialized view of **4,684 rows / 2,184 kB**.

⚠ Row count moved 4,680 → 4,684 across the day, but that is **not** evidence the content is static — `panini-ingest` runs **840×/day** and wrote 1,901 rows. I checked, because "I verified a COUNT, never the VALUES" is a recorded failure here. **Cutting the cadence would have genuinely staled the board — that was my first instinct and it was wrong.**

## The actual defect — `EXPLAIN` named one culprit, not the one I assumed

```
SubPlan 2  is_rookie  ->  Seq Scan on panini_card_serials  (cost 18,755)   x4,684
SubPlan 3  is_debut   ->  Index Scan                       (cost 25)       x4,684
SubPlan 5  count(*)   ->  Index Scan                       (cost 25)       x4,684
FMV lateral           ->  Index Scan                       (cost 1.69)     x4,684  <- already cheap
```

⭐ **`nft_type LIKE '%rookie card%'` is a leading-wildcard predicate no btree can serve, and the planner estimates 21,212 matches — so it abandons `idx_panini_serials_edition` and SEQ SCANS the whole 88,086-row table ONCE PER EDITION.** `is_debut` is the *same shape* and estimates 10 matches, so it keeps the index. **Two identical constructs, opposite plans, purely estimate-driven.**

I had assumed the per-edition FMV lateral — the shape I removed from three other functions today. It was the cheapest thing in the plan. ⚠ **Pattern-matching to this morning's fix would have optimised the wrong subquery.**

## The fix

Three correlated subqueries collapse into ONE grouped pass:

```sql
LEFT JOIN (SELECT edition_external_id,
                  COALESCE(bool_or(nft_type LIKE '%rookie card%'), false) AS is_rookie,
                  COALESCE(bool_or(nft_type LIKE '%debut card%'),  false) AS is_debut,
                  count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS serials_with_recorded_price
           FROM panini_card_serials GROUP BY 1) sa ON sa.edition_external_id = e.external_id
```

`EXPLAIN (ANALYZE, BUFFERS)`: **1,402 ms · shared hit=21,775 read=17,993**, `panini_card_serials` now ONE seq scan → HashAggregate. Reads per refresh **56,789 → 17,993 blocks**.

### Equivalence, proven not asserted — all 4,684 rows, ids matched 4,684/4,684

| column | diffs | verdict |
|---|---|---|
| `is_rookie` **(changed by this rewrite)** | **0** | — |
| `is_debut` **(changed by this rewrite)** | **0** | — |
| `serials_with_recorded_price` | 3 | all 3 have a serial `captured_at` AFTER the 21:48:00Z refresh |
| `fmv_usd` | 14 | byte-identical lateral in both bodies |
| 17 untouched passthrough cols | 11 | **11 of 11** have `panini_editions.updated_at` after 21:48:00Z |

Every difference is ingest drift in the comparison window. **Zero attributable to the rewrite.**

## ⛔ I introduced a security regression and caught it in verification, not from a monitor

The retired MV had `postgres | service_role`. Its replacement came out of `CREATE MATERIALIZED VIEW` with **`anon=rxm` and `authenticated=rxtm`** — Supabase's `ALTER DEFAULT PRIVILEGES` on schema `public` apply to every new relation. **Replacing an object does not inherit the original's ACL; it inherits the schema default, which is wider.**

`panini_squeeze_board` is itself NOT anon-readable, so for ~12 minutes the underlying MV was directly reachable by anon through PostgREST while the surface built on it was not. Revoked in `20260823220755`.

⛔ **`check_public_security_invariants()` returned 0 rows the whole time.** It checks RLS on base tables, `security_invoker` on views and anon EXECUTE on destructive functions — **it does not diff a replaced object's ACL against the one it replaced.** Green was not evidence.

👉 **New rule: on any object swap, capture `relacl` from the object being replaced and reapply it explicitly, then diff.**

## ⚠ What is NOT established

- **The headline is NOT "234 s → 1.4 s".** The old job was bimodal *by slot*: `:18` ran 211.5 s and 195.3 s while `:48` ran 3.5 s and 10.7 s. It already achieved 3.5 s in a quiet window. The load-independent claim is the **read count (56,789 → 17,993) and 4,684 → 1 seq scans**, not the wall clock.
- One post-ship datapoint (a manual run, 1,423 ms) in the **quietest hour on the board**. That is the warmest possible condition — the error I made on jobid 357 earlier today.
- ⭐ **The `:18` slot is therefore the real test**, and a watch is scheduled for 23:00Z covering the 22:18 and 22:48 ticks with the hourly load control read alongside.

## Migrations

`20260823220439` create v2 · `20260823220555` repoint board (+ `security_invoker` restored in the same transaction) · `20260823220648` drop old, rename v2 into place · `20260823220755` revoke the anon leak. All four md5-verified and written to `supabase/migrations/`. `refresh_panini_squeeze()` and cron 353 are UNCHANGED — the rename means the function's literal name resolves to the new MV. Revert path in the header of `20260823220648`.
