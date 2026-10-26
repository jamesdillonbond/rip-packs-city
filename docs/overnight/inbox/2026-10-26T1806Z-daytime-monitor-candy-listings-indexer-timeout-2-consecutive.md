# candy-listings-indexer — 2 consecutive edge-fn timeouts (12:35Z + 15:35Z), 0 rows; was healthy at 09:35Z

**Filed:** 2026-10-26 ~18:06Z (daytime health monitor, read-only pass)
**Priority:** LOW (candidate for the nightly pass to look at; not urgent)

## Signal
`rpc_ops_snapshot().pipeline_alerts` fired `running_but_not_succeeding` (severity medium) for
`candy-listings-indexer`: "2 run(s) in the last 400 min, ZERO ok and ZERO rows written — the
pipeline is FIRING but doing no work. Last run 2026-10-26 15:35Z."

`pipeline_runs` detail (source):
- 06:35Z — ok, 1390 rows
- 09:35Z — ok, 1390 rows
- **12:35Z — FAIL, 0 rows, `The operation was aborted due to timeout`**
- **15:35Z — FAIL, 0 rows, `The operation was aborted due to timeout`**

So the lane was healthy as recently as 09:35Z (1390 rows) and began timing out at the 12:35Z
tick. The sibling `candy-sales-indexer` also timed out once at 12:20Z but recovered (15:20Z ok),
so the 12:xxZ window saw a broad hit; only `candy-listings-indexer` is still failing.

## NOT a saturation spell — cause is real, not deferred
Positive control at 18:06Z: `pg_stat_activity` io_wait=0, active=1 (only this probe).
`rpc_ops_snapshot()` and every sweep query returned fast. This is an **edge-function-level
timeout** (the Supabase->upstream fetch aborting), not DB saturation collateral — so it is a
genuine cause, filed as such, not a spell symptom.

## Risk read — LOW
- Candy (`candy_mlb`) is the **Trevor-only frozen book (#58)**: secondary trading stopped
  2026-10-11; `candy_sales_stale_hours` BREACH is the known, tracked consequence. This lane
  indexes **listings/asks**, which are still fresh by other metrics
  (`candy_offers_oldest_active_hours` 5.2 ok, `candy_ask_book_drop_pct` -7.8 ok,
  `candy_fmv_stale_hours` 0.6 ok).
- Last successful listings write was 09:35Z (~8.5h ago). The ask book will slowly stale if the
  timeout persists, but FMV and offers are unaffected and nothing is lost on a failed tick
  (a failed sweep writes nothing and is re-asked next tick).

## Suggested action (nightly pass / CC)
Investigate why the listings sweep crosses its abort timeout since ~12:35Z — the two good runs
wrote 1390 rows each, so a likely cause is the sweep/page getting heavier or upstream (Magic
Eden / Solana RPC) latency rising past the edge-fn deadline. Candidate fixes: page-size /
per-page timeout tuning, or pagination so a single tick does less work. Low urgency given the
frozen-book context — confirm it hasn't self-cleared on the next tick first.

**Source:** `rpc_ops_snapshot().pipeline_alerts`; `pipeline_runs` (candy-listings-indexer,
candy-sales-indexer). Not on the Declined list; no open ledger/inbox item covers it today.
