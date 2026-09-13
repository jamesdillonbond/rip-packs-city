# The counterparty claim needs partial indexes that carry its source exclusions — owed, in a calm window

*(Claude Code, cloud, 2026-09-13 ~11:00 PT. **SPECIFIED AND ATTEMPTED, NOT SHIPPED** — the build was aborted by a client timeout and backed out cleanly. A floor raise is holding the line in the meantime.)*

## The state this leaves behind

`claim_sales_counterparty_batch` is correct and currently CHEAP, because
`sales_counterparty_backfill_state.floor_sold_at` was raised **2023-11-08 → 2026-01-01** at
10:53 PT so partition pruning keeps every scan on `sales_2026`. Measured immediately after:
**103 buffers, 586 ms** for a 120-row claim, against **61,320 buffers / 13.7 s** ten minutes
earlier at the old floor.

⚠ **That is containment, not a fix.** The floor puts ~150 known-eligible `sales_2025` rows
(144 `ts_history_backfill_v1` + 6 `onchain_dapper_v1`) and an unmeasured `sales_2024`/`2023`
set out of reach. They are not lost — nothing was deleted — but the lane will never see them
until the floor comes back down, and the floor cannot come back down until this filing is done.

## Why the descent is expensive

Below 2026 the `seller_address IS NULL` population is almost entirely rows the claim already
excludes by source, and the existing `idx_sales_<yr>_nullseller_soldat` indexes — keyed
`(sold_at DESC) WHERE seller_address IS NULL` — carry every one of them:

| partition | rows | disposition |
|---|---:|---|
| `sales_2025` `allday_studio_history_v1` | 64,012 | excluded by source |
| `sales_2025` `ufc_studio_history_v1` | 24,691 | excluded by source |
| `sales_2025` `golazos_studio_history_v1` | 250 | excluded by collection |
| `sales_2025` `ts_history_backfill_v1` | 144 | **eligible** |
| `sales_2025` `topshot_marketplace` | 11 | excluded (`20260913173355`) |
| `sales_2025` `onchain_dapper_v1` | 6 | **eligible** |
| `sales_2024` null-seller, total | 220,424 | per `20260913074912`, 100% studio-history |

**~309,000 index entries read to reach ~150 useful ones**, discarded in a post-Filter because
the index predicate does not know about `source`. Two ticks (10:41, 10:51 PT) died on
`claim failed: canceling statement due to statement timeout`, and a `count(*)` over the 2024
eligible set exceeded 25 s from a psql session on a saturated instance.

⛔ **The failure mode is worse than slow.** A claim that TIMES OUT never reaches the
`GET DIAGNOSTICS … IF v_found = 0` branch, so `exhausted_at` is never stamped and the 2-hour
cooldown the re-arm exists to provide can never engage. The lane retries every 5 minutes
forever instead of cooling down.

## The fix, ready to run

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2025_claimable_soldat
ON public.sales_2025 (sold_at DESC)
WHERE seller_address IS NULL
  AND source IS DISTINCT FROM 'allday_studio_history_v1'
  AND source IS DISTINCT FROM 'ufc_studio_history_v1';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_2024_claimable_soldat
ON public.sales_2024 (sold_at DESC)
WHERE seller_address IS NULL
  AND source IS DISTINCT FROM 'allday_studio_history_v1'
  AND source IS DISTINCT FROM 'ufc_studio_history_v1';
```

Then, and only after both report `indisvalid = true`:

```sql
UPDATE public.sales_counterparty_backfill_state
   SET floor_sold_at = '2023-11-08T17:00:00Z'::timestamptz, updated_at = now()
 WHERE id = 1;
```

Record both with an `IF NOT EXISTS` migration so they are not fileless.

## Three things that will bite whoever picks this up

1. ⚠ **The predicate must be spelled `IS DISTINCT FROM`, clause for clause as the claim writes
   it.** Postgres proves index-predicate implication by matching clauses structurally; the
   logically identical `source NOT IN (...)` or `(source IS NULL OR source NOT IN (...))` would
   build a correct index the planner never chooses. There is no error to see — just no speedup.
2. ⛔ **Do NOT put `topshot_marketplace` in the index predicate**, even though the claim now
   excludes it. An index predicate must be IMPLIED BY the query, so extra query clauses are
   free, but a predicate clause with no matching query clause kills the match — and leaving it
   out means the index survives a revert of `20260913173355`. It costs 11 rows in 2025.
3. 🚨 **`CREATE INDEX CONCURRENTLY` via `execute_sql` only works if it FINISHES inside 60 s.**
   This repo's note that "CIC DOES run via `execute_sql` (105 MB index, 09-09)" is true and
   incomplete: the MCP client returns at 60 s, and the abort left
   `idx_sales_2025_claimable_soldat` at `indisvalid=false, indisready=true` — invisible to the
   planner, still maintained on every write. It was dropped cleanly with a **single-statement**
   `DROP INDEX CONCURRENTLY IF EXISTS` (the multi-statement form fails `25001 … cannot run
   inside a transaction block`), 0 leftover `pg_class` rows verified. **So run this in the
   02:00–06:00Z quiet window**, and if the client times out, poll `pg_index.indisvalid` rather
   than retrying — the build may still be running server-side.

At the attempt (10:5x PT) the instance was saturated: autovacuum 765 s, `refresh_wmc_fmv_changed`
273 s, `atlas_listing_verify_tick` 90 s, every backend on `IO: DataFileRead`.

## Exit condition and falsifier

**Exit:** both indexes `indisvalid = true`, the floor back at 2023-11-08, and a claim at a
2024-era cursor planning under ~1,000 buffers.
**Falsifier:** if a claim at a 2024-era cursor still shows a large `Rows Removed by Filter` on
`idx_sales_2024_nullseller_soldat`, the predicate was not matched — re-read point (1) before
concluding the index was a bad idea.
