# Daytime monitor candidate — get_wallet_pack_summary 8s RPC_READ_TIMEOUT (low-frequency, user-facing)

**Filed:** 2026-10-10 ~11:08 PM PT (daytime read-only monitor pass). Platform otherwise GREEN this tick.

## Candidate

**Title:** `/api/wallet/pack-summary` → `get_wallet_pack_summary` occasionally exceeds the 8000 ms RPC read budget and answers a user-facing timeout.

**Source:** Vercel production runtime logs, last 24h. 3 distinct requests, all clustered in a 22-minute window 2026-10-11 03:46–04:08Z (≈ 8:46–9:08 PM PT 10-10), on deployments `dpl_2Ag4gnNXpzyRw49syVqQVVupmVDM` and `dpl_2GpdPAEvSXT1MeBSFhckZpJR1g7o`. Log line: `[api/wallet/pack-summary] code=timeout detail=RPC_READ_TIMEOUT [api/wallet/pack-summary/get_wallet_pack_summary] read exceeded 8000ms`. No other `pack-summary` error lines in the window.

**Not a regression from tonight's ship:** the timeouts predate the 10-10 pack-EV / box-realizes-packs deploys (`4213a2c` #188 and the offers/sales.offer_id commits, all built ~05:00Z 10-11). The failing deployments are earlier builds, and no new `pack-summary` error lines appear on the #188 deploy. So this reads as a pre-existing slow-read on a heavy wallet, not a new break — it has simply not been logged before (ledger has `get_wallet_pack_summary` feature entries but no timeout entry; last comparable fix was the 2026-10-04 `get_collection_stats` RPC_READ_TIMEOUT, bounded by a 7-day filter).

**Risk read:** LOW blast radius, LOW fix risk. Low frequency (3/24h, one burst → likely one owner reloading a large wallet). Not in a saturation spell at filing time (positive control: 0 IO-wait / 2 active sessions; `rpc_ops_snapshot()` returned promptly), so the read is interpretable and this is a real query-cost issue, not saturation collateral. User impact is a failed pack-summary panel for the affected (large) wallet.

**Suggested action (night pass / Trevor):** profile `get_wallet_pack_summary` for a large multi-collection wallet in a quiet window — `EXPLAIN (ANALYZE, BUFFERS)` the function body against the heaviest known wallet (e.g. 0xbd94…50ac) and look for an unbounded scan over pack history / sales that the `get_collection_stats` 7-day-bound precedent (ledger 2026-10-04, `20261004170500`) would also cure here, or a missing selective index on the per-wallet pack lanes. Verify the fix by `EXPLAIN` row-estimates, not a single warm wall-clock. Do NOT ship from a single timing. No action taken this pass (read-only monitor).

---

## 📏 MEASURED 2026-10-11 ~8:45 AM PT (Claude Code, Trevor's box) — still OPEN; the cost is `wallet_held_pack_value`, not the summary's own scans

**Scope is wider than one whale.** `get_wallet_pack_summary` was timed against the six heaviest pack openers (`pack_rips` rows, via `execute_sql`, no client budget). First call (cold): `0x640705263fe8f11b` (34,520 rips) **15.4 s** · `0xe0680be899be88ed` **10.3 s** · `0x10725d006b1a680e` 6.1 s · `0x489710e94122914d` 5.2 s · `0xbee776009d396a51` 4.0 s · `0x1461d02c162c0d79` 3.7 s. At least two wallets get no pack summary against the route's 8 s `boundedRead` budget.

**Where the time goes** (`0x6407…`, warm): total **5.7 s**, of which `wallet_held_pack_value` takes **3.5 s (61 %)**. Every per-wallet scan is under 25 ms (`pack_rips` opener 24 ms for 34,520 rows, `pack_purchases` buyer 2 ms, `topshot_pack_sales_history` buyer 2 ms). That confirms the night pass: it is not an index problem.

**Why the held value costs that much.** `wallet_held_pack_value` pages `get_wallet_pack_history(w, NULL, 'held', 200, offset)`. Each call builds the wallet's **entire** history (every buy, sell, rip and index row, all enrichment) and filters to `held` at the end. For `0x6407…`, which holds **0** sealed packs, one page costs ~3.6–4.0 s whether `p_limit` is 200 or 5,000. A wallet with N held packs pays that ~ceil(N/200) times.

**Rejected lever (measured):** an EXISTS pre-check would short-circuit an empty held list. A pack can be `held` only with a buy or `idx_hold` role and no rip / `idx_open`. Sells cannot be subtracted, because a pack sold and bought back can be held. But the superset was non-empty for 5 of the 6 wallets (26 / 607 / 4 / 1 / 95 candidates vs 0 / 3 / 0 / 0 / 0 actually held), so it would fix almost nothing.

**Levers for the profiling session:**
1. Push the status filter INTO `get_wallet_pack_history` before the enrichment joins (pricing, EV, asks, inference) when `p_status = 'held'`. Classification needs only the `events → dedup → classified` keys and owner/index columns.
2. Or give `wallet_held_pack_value` its own lean held-key query that reuses the history's classification CTEs and enriches only the held rows.
3. Do NOT raise the route budget or the function's `statement_timeout` as the fix: the cold time (15.4 s) already exceeds the function's own 15 s.

Verify by BUFFERS on `0x6407…` and `0xe068…` (cold), and diff the `held` object before and after for all six wallets (it must be byte-identical).
