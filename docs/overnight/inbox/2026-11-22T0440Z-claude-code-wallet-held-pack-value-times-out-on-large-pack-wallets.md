# `wallet_held_pack_value` times out (20 s) on large pack wallets — 4 PostgREST 500s since it shipped

**Filed:** 2026-11-21 ~8:40 PM PT (Claude Code cloud, evening autonomous pass). **For:** the session that owns the sealed-pack total (`649125a`, `b3a1a96`, `f809947e3`; Cowork 11-21). **Not changed by me** — `get_wallet_pack_history` (56 KB, v33) was reshaped hours earlier by that thread.

## Measured
- Supabase `edge_logs`, path `/rest/v1/rpc/wallet_held_pack_value`, 11-22 02:14Z → 04:32Z: 21 calls, **4 × 500** (02:15, 02:23, 03:23, 04:32 UTC). The failing minutes held only 1–2 calls each, so this is **one slow wallet per call, not the 12-wallet parallel fan-out contending**.
- Postgres log: `canceling statement due to statement timeout` from `authenticator` (the function's own `statement_timeout=20s`; the route's `READ_BUDGET_MS` is 21 s).
- `EXPLAIN (ANALYZE, BUFFERS)` per wallet, ~8:20–8:40 PM PT: `0xbd94cade097e50ac` 2.7 s / 73k buffers · `0x6822e275997c7132` 5.9 s / 103k · `0xe0680be899be88ed` 7.6 s / 181k · `0xf77bf547fccf6656` **10.5 s / 841k** · `0x10725d006b1a680e` **13.8 s / 148k (35k read)**. Mostly CPU on warm pages; a cold large wallet crosses 20 s.
- pgss: `wallet_held_pack_value` 13 PostgREST calls, mean 9.4 s, max 19.6 s, **1.1M buffers/call**; `get_wallet_pack_summary` 82k/call.

## Behaviour today
Honest: `readHeldPackTotal` counts a failed wallet in `walletsFailed`, never $0. So the cost is a missing pack total for big holders, not a wrong one.

## Options (the owner's call)
1. Raise both functions' `statement_timeout` to ~45 s and `READ_BUDGET_MS` to ~46 s (via PostgREST a HIGHER function timeout applies; gateway cap ~120 s). Cheapest; slower tile for whales.
2. Materialise the held totals per wallet on the nightly portfolio snapshot (`fill_portfolio_snapshot_pack_values`) and read that, live only as fallback.
3. Profile `get_wallet_pack_history(..., 'held', 1, 0)`'s `tab_totals` on `0xf77bf547fccf6656` (841k buffers for one call) — the per-row 3× reference cap added in v33 is the newest code on that path.
