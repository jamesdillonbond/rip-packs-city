# #228 collection-snapshot timeout recurred after the covering-index fix — watch falsifier tripped

**Filed:** daytime health monitor, 2026-11-03 ~8:15 PM PT (UTC stamp in filename). READ-ONLY sense; no fix attempted.

**One-line:** The 2026-11-03 #228 ship (APPLIED `20261104013841`: `get_wallet_collection_snapshot` aggregates from a covering index) set an explicit watch — "no `RPC_READ_TIMEOUT` on the route for 30 days (falsifier: any hit after 5:40 PM PT 11-03)". A `RPC_READ_TIMEOUT` hit landed at **2026-11-04T01:53:44Z (~5:53 PM PT 11-03)**, ~15 min after the function+index were applied at **01:38:41Z (~5:38 PM PT)**. The falsifier has tripped.

**Source:**
- Vercel runtime errors (24h, read 04:1xZ 11-04): group `[api/collection-snapshot] code=timeout detail=RPC_READ_TIMEOUT … read exceeded 8000ms`, count=8 users=6, **last=2026-11-04T01:53:44Z**. (The count is cumulative since 2026-09-11; the load-bearing fact is the `last` timestamp, which post-dates the apply.)
- Migration `20261104013841_audit_20261103_collection_snapshot_aggregates_from_the_index` present in `schema_migrations`; both `idx_wmc_wallet_coll_ek_snap_cover` (new cover) and `idx_wmc_wallet_coll_ek_fmv_tier` (old subset, its drop staged) exist in `pg_indexes`.
- Ledger 2026-11-03 "#228 APPLIED + INDEX BUILT" entry and its **Watch** line.

**Risk read:** LOW blast radius — the route returns an honest 503 ("cannot read in one pass"), not a crash and not fabricated data; it fires only on the largest cache-cold wallets (measured ~11.3s cold vs 685ms warm pre-fix, ~1 hit per ~12 days). This is NOT a saturation spell: `rpc_ops_snapshot()` and all monitor queries returned fast this pass, so the reading is direct, not a symptom-under-saturation. The finding is simply that the covering-index fix did **not** fully eliminate the cold-whale timeout within its first hour live.

**Suggested action (night pass / Trevor — NOT the monitor):** re-measure, don't conclude. `EXPLAIN (ANALYZE, BUFFERS)` `get_wallet_collection_snapshot` on the ~70k-row whale wallet cache-cold and confirm which index the planner actually chooses. HYPOTHESIS TO VERIFY, not asserted: with both the new cover index and the old larger `idx_wmc_wallet_coll_ek_fmv_tier` present, the planner may still pick the old one, so the fix may not be getting exercised — the staged drop/rename in `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` is still pending Trevor (raised the MCP destructive prompt, unanswered). If the cover index is chosen and 45k buffers still exceeds the 8s budget cold, the lever is a further reduction, not this index. Do not revert #228; the fix reduced buffers/time materially (75k→45k buffers, 762→470ms warm-ish instrument).
