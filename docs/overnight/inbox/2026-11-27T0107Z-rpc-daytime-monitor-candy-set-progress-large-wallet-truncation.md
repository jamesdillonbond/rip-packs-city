# Candy set-progress read truncates for large candy wallets (maxPages=20 / 57014 timeout)

**Filed:** 2026-11-27 ~01:07Z by `rpc-daytime-monitor` (read-only daytime pass). Written to the MOUNT — push route unavailable this run (VM `/sessions` disk 100% full, 0 bytes; same block as `2026-11-26T1936Z-rpc-daytime-monitor-vm-sessions-disk-full-blocks-push-route-1.md`). Night pass: sweep onto main and add the INDEX.md entry in that commit.
**Priority:** LOW
**Source:** Vercel runtime errors (production, last 18h), route `/api/candy-set-progress` — two facets of one event:
- `[candy-set-progress/owned] hit maxPages=20; result is partial` — count 3, 2 users, 2026-11-26T23:24:58Z → 2026-11-27T00:49:25Z, lastDeployment `dpl_gi5FJEZ1` (087eef75).
- `[api/candy-set-progress] code=timeout detail=57014 candy holdings read was truncated` — count 3, 2 users, same window/deploy.

**What it is:** a NEW-today cluster (both groups first seen 23:24Z 11-26). A large candy wallet's set-progress read either hits the route's 20-page pagination cap or the candy-holdings read hits statement_timeout (57014), and the route returns a PARTIAL / truncated set-progress to the user. Honest, logged degradation (returns partial) — not a crash, no write path, no data-integrity defect. candy_mlb now carries ~21,534 editions, so a whale candy wallet's full holdings walk is crossing the read budget.

**Risk read:** LOW. User-facing data-completeness degradation (set progress may undercount a very large candy wallet), confined to 2 users / 3 events in ~1.5h. Not attributable to a ship — the deploy on the rows is just the current prod and its change (pack sniper) is unrelated to this route.

**Suggested action (night pass):** identify the affected wallet(s) from the route's own log / `usage_events.metadata`, confirm it is whale-wallet-bound (one or two large candy wallets) vs a general regression, then consider a covering index or a budget raise on the per-wallet candy holdings scan, or a higher/removed `maxPages` for candy given edition-count growth. Verify any fix with EXPLAIN (the read actually index-binding), not wall-clock.

**Not a spell:** positive control at 01:05Z was io_wait 7 / active 6 with a fast `rpc_ops_snapshot()` and fresh trust health — no saturation, so this is a genuine per-wallet read-budget issue, not uninterpretable saturation collateral.
