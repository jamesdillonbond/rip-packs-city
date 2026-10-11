# Daytime monitor candidate — get_wallet_pack_summary 8s RPC_READ_TIMEOUT (low-frequency, user-facing)

**Filed:** 2026-10-10 ~11:08 PM PT (daytime read-only monitor pass). Platform otherwise GREEN this tick.

## Candidate

**Title:** `/api/wallet/pack-summary` → `get_wallet_pack_summary` occasionally exceeds the 8000 ms RPC read budget and answers a user-facing timeout.

**Source:** Vercel production runtime logs, last 24h. 3 distinct requests, all clustered in a 22-minute window 2026-10-11 03:46–04:08Z (≈ 8:46–9:08 PM PT 10-10), on deployments `dpl_2Ag4gnNXpzyRw49syVqQVVupmVDM` and `dpl_2GpdPAEvSXT1MeBSFhckZpJR1g7o`. Log line: `[api/wallet/pack-summary] code=timeout detail=RPC_READ_TIMEOUT [api/wallet/pack-summary/get_wallet_pack_summary] read exceeded 8000ms`. No other `pack-summary` error lines in the window.

**Not a regression from tonight's ship:** the timeouts predate the 10-10 pack-EV / box-realizes-packs deploys (`4213a2c` #188 and the offers/sales.offer_id commits, all built ~05:00Z 10-11). The failing deployments are earlier builds, and no new `pack-summary` error lines appear on the #188 deploy. So this reads as a pre-existing slow-read on a heavy wallet, not a new break — it has simply not been logged before (ledger has `get_wallet_pack_summary` feature entries but no timeout entry; last comparable fix was the 2026-10-04 `get_collection_stats` RPC_READ_TIMEOUT, bounded by a 7-day filter).

**Risk read:** LOW blast radius, LOW fix risk. Low frequency (3/24h, one burst → likely one owner reloading a large wallet). Not in a saturation spell at filing time (positive control: 0 IO-wait / 2 active sessions; `rpc_ops_snapshot()` returned promptly), so the read is interpretable and this is a real query-cost issue, not saturation collateral. User impact is a failed pack-summary panel for the affected (large) wallet.

**Suggested action (night pass / Trevor):** profile `get_wallet_pack_summary` for a large multi-collection wallet in a quiet window — `EXPLAIN (ANALYZE, BUFFERS)` the function body against the heaviest known wallet (e.g. 0xbd94…50ac) and look for an unbounded scan over pack history / sales that the `get_collection_stats` 7-day-bound precedent (ledger 2026-10-04, `20261004170500`) would also cure here, or a missing selective index on the per-wallet pack lanes. Verify the fix by `EXPLAIN` row-estimates, not a single warm wall-clock. Do NOT ship from a single timing. No action taken this pass (read-only monitor).
