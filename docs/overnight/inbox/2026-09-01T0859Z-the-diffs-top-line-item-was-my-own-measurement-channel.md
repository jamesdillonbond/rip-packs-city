> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# Inbox — 2026-09-01T08:59Z (cloud) — the saturation diff's #1 line item was my own measurement channel

**Three things a future pass should not have to re-derive.**

## 1. `public.query_sql` is the Supabase MCP's passthrough. Rank it out of every pgss diff.

On the 08:05→09:01Z diff it was the **top line item by `shared_blks_read`**: 50 calls, 3,611 ms/call, 6.24 M buffers.
Body: `EXECUTE format('SELECT coalesce(jsonb_agg(row_to_json(t)), …) FROM (%s) t', query)`. That is every SQL statement
this pass — and every previous pass — has run through the MCP.

⛔ Rank it out beside `audit_20260830_pgss_snap` itself. The 08-31 0219Z entry concluded the top item "was never the
pass's own channel"; on this window it **is**, so the check is per-pass, not inherited.

Once ranked out, the real #1 non-self consumer is `refresh_seeded_wallet_stats`: 48 calls, 10,297 ms/call,
52,832 buffers/call ≈ **494 s of DB time per hour**.

## 2. Widening a covering index to kill a heap fetch bought 3 %, not 25 % — and the positive control is why we know

`fmv_snapshots_2026_edition_id_computed_at_conf_idx` (migration 20260901023633, titled *"the latest CTE paid a heap
fetch per row"*) includes `confidence` but **not** `fmv_usd`, so real callers still get an `Index Scan`. The obvious
fix is to widen the INCLUDE. Measured on 518 UFC editions:

- callers' column set → `Index Scan`, **2,072 buffers** (4.00/probe)
- **positive control**, index-covered columns only → `Index Only Scan`, **2,002 buffers** (3.87/probe),
  **`Heap Fetches: 447 / 518` = 86 %**

⭐ **The heap fetch happens anyway.** The table is 99.9 % all-visible (28,868 / 28,889 pages), but a
latest-row-per-key probe lands on the newest tuples, which sit on exactly the pages the visibility map has not marked
— and `fmv_snapshots_2026` takes ~3,745 inserts/hour. ⛔ ~100 MB of index and write amplification on a hot table for
3 %. **Not shipped.**

⚠ **And the wall-clock reading is a trap:** 53.6 ms vs 6.1 ms looks like 9×; it is entirely cache (236 disk reads vs
0). Buffers is the only metric a warm cache cannot fake.

## 3. A watch nobody had answered, and the caller that will not cooperate with a 2-hourly pass

**Answered:** the 08-30 `stampLastRefreshed` gate. Over 56 min — **218 wallet-backfill children, 38 dispatches,
48 `refresh_seeded_wallet_stats` calls (22 %)**. Exit **MET**, falsifier not triggered. Residual worth a later look:
48 calls for 38 dispatches while pinnacle/ufc/golazos children each wrote 0 rows.

**Still open:** the 0818Z `enrich-ufc-wallet` v47 watch. `d_calls = 0` on the old form post-deploy, no new
`pgrst_source` queryid, falsifier clear (0 of 5,455 UFC wmc rows NULL against a priced edition). Reason: the caller
fires in **8 of 24 hours** — last real invocation **08:15:17Z, before the 08:31:42Z deploy**. ⭐ The 0818Z handoff's
"~38 req/h in clusters" overstates continuity. Bursts landed in the 00Z, 01Z, 08Z, 13Z and 20Z hours; a pass that
wants to close this watch should land in one.

⚠ `ops_pgss_delta('35 minutes')` reports **46** calls on that queryid — all pre-deploy. It baselines on the latest
snapshot *older* than the lookback (08:05:00Z here), so it cannot answer a post-deploy question. Diff the two
snapshots directly.
