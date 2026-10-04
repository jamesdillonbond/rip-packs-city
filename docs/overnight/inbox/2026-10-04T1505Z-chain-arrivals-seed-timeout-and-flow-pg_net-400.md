# Daytime monitor — 2026-10-04 ~08:05 AM PT (15:05Z) candidates

Read-only daytime health pass. Sweep was GREEN except the two items below.
Positive control at 15:03Z: `pg_stat_activity` io_wait=0 / active=0 — **NOT in a saturation spell**, so these are interpretable; but candidate 1's failure happened at 04:13 AM PT, so its cause is dual-hypothesis (see below) and wants a quiet-window re-measure before any fix.

Context confirmed green this pass: `rpc_ops_snapshot()` security all-clean, trust_health 0/36 breaches, `detect_stalled_pipelines()` []; cross-collection pg_cron refresh fresh (step1 10:02Z, step2 10:35Z, both succeeded; cohort 198 rows, overlap fresh); latest prod deploy READY (ef77b911); Sentry 0 new unresolved in 24h. Known-expected and NOT re-flagged: `panini-collector-walk` 30% failure_rate (10-min per-walk cap, day-rotated — focus), `pack-mint-probes` (mainnet24 window-missed, focus), the Atlas 403 info rows (fresh drains), `backfill-pack-rip-metadata` running-but-not-succeeding (info).

---

## 1. HIGH — `rpc-chain-arrivals-seed` daily seed hit its 300s statement_timeout (first failure in 5 days); likely regressed by the overnight ~1.59M-row Flowty `sales` incorporation

- **Source:** pg_cron `cron.job_run_details`, job `rpc-chain-arrivals-seed` (schedule `13 11 * * *` = 04:13 AM PT, once daily). Run **2026-10-04 11:13:00Z = FAILED**, `ERROR: canceling statement due to statement timeout` in the body `WITH w AS (SELECT DISTINCT lower(trim(wallet_addr)) ... FROM public.saved_wallets ...)`. Runs 10-01/10-02/10-03 all `succeeded`. Fn `public.seed_saved_wallet_chain_arrivals` proconfig = `statement_timeout=300s` (so it ran >5 min before being killed). State now: `saved_wallets`=165, `chain_arrival_probes`=132,483, `chain_arrival_requests`=0 (hourly lane caught up).
- **Risk read:** LOW blast radius but self-perpetuating. The seed is a daily catch-up that enqueues chain-arrival probes for held Top Shot moments of saved wallets that aren't already pack-pulls/recorded purchases. A miss means moments newly added to saved wallets since yesterday are not seeded today; existing 132k probes are still drained by the every-minute `rpc-chain-arrival-lane`, and `chain_arrival_requests`=0 means no user-facing freshness loss right now. BUT if the cause is structural it will fail again every 11:13Z.
- **Suggested action (night pass, quiet window — SENSING ONLY, do not fix from this pass):** The seed excludes moments that are "a recorded purchase," which reads `public.sales`. The overnight Flowty/Dapper incorporation added ~1.59M rows to `sales` (ledger 10-04 close-out: 1,588,414 chain-verified sales), and the last good seed run (10-03 11:13Z) predates the bulk of that growth while the failing run (10-04) follows it — a **recent-ship correlation**. NOT asserted as cause: the 04:13 AM PT run also overlapped the heavy Flowty-promoter crons (698/699 every 30–45s) + Dapper candidate builds, so transient morning saturation is an alternative. Re-measure in a quiet window (positive control first), `EXPLAIN (ANALYZE, BUFFERS)` the seed's `sales`-exclusion subquery; if it's a seq/large scan add/confirm an index supporting the "recorded purchase" predicate (or batch the seed per wallet), if the plan is cheap treat 10-04 as load collateral and just watch tomorrow's 11:13Z tick. **Do not blindly lengthen the 300s timeout.**

## 2. LOW — `pg_net_http_400` HIGH arm lit on 2 Flow "failed to convert event payload" 400s in 2h; attribute before treating as real

- **Source:** `rpc_ops_snapshot()` pipeline_alerts, `pg_net_http_400` (arm severity high), body `Invalid Flow request: failed to convert event payload for block 92379efd5fcdd...`; 2 pg_net-dispatched calls returned HTTP 400 in the last 02:00:00. `net._http_response` has no url column, so the arm cannot name the endpoint on its own.
- **Risk read:** LOW. Per the focus 10-03 steer, `pg_net_http_400` highs since the Flowty-export teardown are lanes nobody attributed / session probes that age out on their own; the "failed to convert event payload for block <hash>" shape is a Flow Access-API block-read quirk, not our `?key=` gate. Volume is 2 calls.
- **Suggested action:** join `net._http_response.id` to each `*_request_id` table (`atlas_edition_requests`, `topshot_atlas_market_requests`, `topshot_atlas_pack_requests`, `topshot_moment_hydrate_requests`, `atlas_supply_requests`, `chain_arrival_requests`); if unattributed it's a session probe — record it (`error '__probe__ ...'`) and the row clears. Likely needs no action beyond aging out.

---

## ✅ RESOLVED — disposition (Claude Code, Windows box, ~8:25 AM PT 10-04)

**1. Seed timeout: structural, fixed.** Re-measured in a quiet window: the HELD half alone took **67.8 s / 3.58 M buffers**. 2.58 M of those were the "not a recorded purchase" anti-join, which probed all eight `sales` partitions by nft_id for each of 124 k held moments. Earlier runs already took 58–66 s, so the overnight `sales` growth and a busy 4 AM pushed it past 300 s. Migration `20261004160000` (applied; live md5 = file `102f1698…`) keeps the same rows and changes two costs:
- `bought` (MATERIALIZED) reads the saved wallets' purchases once by buyer (~62 k buffers) and hash-anti-joins.
- Moments that already have a probe row are dropped first. The insert is `ON CONFLICT DO NOTHING`, so those rows could never insert (114,140 of 176,313).

**Equivalence on production**, old vs new candidate sets (minus existing probes), EXCEPT both directions: held **56 = 56**, sold **16,072 = 16,072**, 0 differences. The pin test ran on prod in a rolled-back scratch schema: HEAD copy PASS (control), new copy PASS, planted defect FAIL (`S1 … got [2], want [1]`), 0 residue.

**Catch-up run by hand (~8:20 AM PT):** 45.7 s (previous runs 58–66 s; 10-04 died at 300 s). It seeded **16,143** probes (56 held, 16,087 sold) where a normal day seeds 5–11. The overnight Flowty/Dapper promotion added these wallets' historical sells, so every post-floor sale the seed can't explain becomes a probe. The old body would have queued the same rows. They sit in `chain_arrival_probes` as `floor` for the every-minute lane. **Watch:** tomorrow's 4:13 AM PT tick should be well under 60 s, and the 16,143 should drain over the coming days.

**2. Flow 400s: not attributable after the fact, no action.** Two calls (6:44 and 7:12 AM PT), body `failed to convert event payload for block …`. That's the Flow access-node fault class seen on the mainnet24 walks. Neither request id survives in any of the 25 `request_id` tables, because the lanes delete a request row once its response is read.
