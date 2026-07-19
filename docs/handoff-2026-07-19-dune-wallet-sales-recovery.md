# Handoff — per-wallet sale recovery via Dune (`flow.cadence_events`)

**Date:** 2026-07-19 · **From:** Cowork · **For:** Claude Code
**Status:** ready to build. One operator step (saving the Dune query) is called out inline.

---

## Why this exists

`public.sales` carries buyer/seller only for rows the on-chain indexers ingested. The bulk of history came from `ts_history_backfill_v1` and the studio-platform imports, which carry price + edition + serial but **no wallet addresses**. Measured 2026-07-18:

| collection | sales | counterparty coverage |
|---|---|---|
| nba_top_shot | 2,962,790 | **20.9%** |
| nfl_all_day | 527,448 | 12.1% |
| laliga_golazos | 78,250 | 0.2% |
| ufc_strike | 813,435 | 0.0% |

Consequence: the Moments → **Sold** tab is a severe undercount. The reference wallet `0xbd94cade097e50ac` shows **7 lifetime sales** and its true count is far higher.

`workers/sales-counterparty-backfill/` (live, self-scheduled `*/5`) fixes this by decoding each row's own Flow tx, and runs at ~100% recovery — but it walks **newest-first** and has covered ~1.5 days of a ~2.5-year backlog. **2,299,600 NULL rows remain.** The reference wallet's sales span **2024-03-01 → 2026-05-30**, so the worker needs ~67 days to reach them.

**This handoff is the fast path for a SINGLE wallet** — minutes and a few credits instead of two months. It is complementary to the worker, not a replacement.

---

## The insight

Dune's `flow.cadence_events` carries the exact Withdraw/Deposit events, joinable to us by `transaction_hash`. Previously validated: its sellers match our indexer exactly. Cost for the *entire* 2024–26 history was costed at ~167 credits; a **single-wallet predicate is a tiny fraction of that**.

We cannot do this against Flow's public REST API — its events endpoint is queried by **type + block range, not by account**, so "find this wallet's withdrawals" would mean scanning tens of millions of blocks. Dune is the only tractable per-account lane. (Do not re-attempt the REST event-walk; it was already ruled out.)

---

## Step 1 — save a parameterized Dune query (OPERATOR: Trevor)

`workers/dune-proxy` executes **saved query IDs only** — it cannot run ad-hoc SQL. So this must be saved in the Dune UI once, with a `{{wallet}}` parameter, then reused for every wallet.

```sql
-- RPC: moments withdrawn by a wallet (= that wallet's sales)
-- Parameter: wallet (text), e.g. 0xbd94cade097e50ac
select
  transaction_hash,
  block_timestamp,
  event_type,
  json_extract_scalar(payload, '$.id')   as nft_id,
  json_extract_scalar(payload, '$.from') as seller
from flow.cadence_events
where json_extract_scalar(payload, '$.from') = '{{wallet}}'
  and (
       event_type like 'A.0b2a3299cc857e29.TopShot.Withdraw'
    or event_type like 'A.e4cf4bdc1751c65d.AllDay.Withdraw'
    or event_type like 'A.329feb3ab062d289.UFC_NFT.Withdraw'
  )
order by block_timestamp desc
```

Record the resulting numeric query id. **Verify the shape before trusting it** — `flow.cadence_events` column/payload naming should be confirmed against Dune's schema browser; the `json_extract_scalar` paths above are the expected shape but have NOT been executed. If `payload` is already a struct rather than JSON text, use dot access instead.

## Step 2 — execute + fetch via the proxy (CC can do this)

```
POST https://dune-proxy.tdillonbond.workers.dev/execute?query_id=<id>
  Authorization: Bearer $DUNE_PROXY_SECRET
  body: { "query_parameters": { "wallet": "0xbd94cade097e50ac" } }

GET  .../status?execution_id=<id>     # poll until QUERY_STATE_COMPLETED
GET  .../results?query_id=<id>&limit=&offset=
```

## Step 3 — write the results

Reuse the existing engine — do **not** write to `sales` directly:

```
public.apply_sales_counterparty(p_rows jsonb)
-- rows: [{sale_id, seller, buyer, sold_at}, ...]
```

It is fill-only (`COALESCE` + `IS NULL` guard, verified non-clobbering against a poisoned replay), idempotent, audited into `sales_counterparty_recovered`, and does no INSERT/DELETE on `sales`. Match Dune rows to `sales` on `transaction_hash` (and `nft_id` where present) to get `sale_id`.

**Set `buyer` to NULL for AllDay/UFC.** Those collections deposit to a constant Dapper custodian (`0xddfbe848a81b2236`), so writing it as the buyer would be a lie. Seller only. (Top Shot deposits to the real buyer, so both sides are fine there.)

### ⚠ CURSOR TRAP — read before calling apply

`apply_sales_counterparty` advances `sales_counterparty_backfill_state.cursor_sold_at` using `LEAST(existing, batch_min)` — it is deliberately **monotonically decreasing**. Feeding it 2024-era Dune rows will therefore **drag the worker's cursor back to 2024**, abandoning its newest-first position and making it re-walk ground it already covered.

That is not data-destructive (filled rows drop out of the claim, which filters `seller_address IS NULL`), but it wrecks the newest-first strategy that puts live-user value first.

**Pick one, deliberately:**
1. **Preferred** — add a `p_advance_cursor boolean DEFAULT true` argument to `apply_sales_counterparty` and pass `false` for Dune-sourced batches. Keeps one audited write path. Note: adding an argument creates a NEW overload signature — re-grant explicitly (`postgres`, `service_role`) and **REVOKE from `anon, authenticated` by name**; `REVOKE ... FROM PUBLIC` does NOT strip Supabase's default grants (this exact trap bit during the original build).
2. Snapshot `cursor_sold_at` before, restore it after.

---

## Verification

1. `select count(*) from sales where seller_address = '0xbd94cade097e50ac';` — was **7**; expect a large jump.
2. Spot-check 3 recovered rows against the on-chain `Withdraw.from` (the AllDay extension was verified this way).
3. Load `/nba-top-shot/collection?wallet=0xbd94cade097e50ac&moments=sold` and confirm the count and proceeds move.
4. Security post-flight: `check_public_security_invariants()` `[]`, `check_secdef_anon_execute_violations()` `[]`, `tables_without_rls` 0.
5. Confirm the worker still holds its cursor (see the trap above) — `select cursor_sold_at from sales_counterparty_backfill_state;` should still be recent, not 2024.

## Revert

- Values written: `UPDATE sales s SET seller_address=NULL, buyer_address=NULL FROM sales_counterparty_recovered r WHERE r.sale_id=s.id AND r.recovered_at > '<run start>';`
- Function change (option 1): drop the new overload, restore the prior definition from migration history.
- The saved Dune query is inert if unused.

## Follow-on (the bigger prize)

The same source can supersede the worker entirely: ~167 credits for the full 2024–26 history vs the worker's ~67-day grind at 34.5k rows/day. That is a **separate, larger build** — a proper pipeline in the shape of `ownership-sync-dune` with its own cron, writing ~1.6M rows into the hot `sales` table. Do **not** bolt it onto this handoff; this one is the per-wallet feature, which is also reusable for any verified user on demand.
