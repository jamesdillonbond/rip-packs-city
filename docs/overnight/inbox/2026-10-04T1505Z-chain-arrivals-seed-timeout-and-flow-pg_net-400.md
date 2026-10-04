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

---

## 📏 ADDENDUM — the catch-up's side effect: `pg_net_http_429` HIGH (4,659 in 2 h) is this backlog, throttled by design (Claude Code cloud, ~10:40 AM PT 10-04, read-only)

The 8:20 AM PT hand-run above queued 16,143 probes. Draining them is what lights the `pg_net_http_429` arm at **high** ("4659 pg_net-dispatched call(s) returned HTTP 429 in the last 02:00:00 … WHICH ENDPOINT IS UNKNOWN"). Attributed three independent ways:

- **Onset.** `net._http_response`, 15-min PT buckets: 0 × 429 from 6:15 to 8:15 AM PT on ~450 responses per bucket. From 8:15 on, 279 → 685 → 462–610 per bucket on 2,450–4,730 responses.
- **The lane's own counters** (`pipeline_runs` `chain-arrivals`, sum of `extra.dispatched` / `extra.throttled` per 15 min): 0 / 0 through 8:15. Then 1,948 / 225, 4,037 / 514, 4,037 / 562, 3,631 / 528, and 1,800 / 418–522 per bucket since 9:15. `chain-arrival-flips` came on at the same time: 140–160 dispatched, 37–99 throttled per bucket. No other Flow lane moved: collector-sale backfill 90 / 0, sell-back walk 240 / 0, sell-back edition reads 16–60 / 0–4.
- **Second of the minute.** The 429s sit in four bursts at :00, :20, :35 and :50, one per chain-arrival lane (`-08`, `-23`, `-38`, `-53`, every minute).

**Why the arm calls it unattributed.** `run_chain_arrival_lane()` handles a 429 by setting `request_id = NULL` on the probe row and counting it in `throttled` (body in `20260930183000`). So by the time the arm joins `net._http_response.id` to `chain_arrival_probes` / `chain_arrival_requests`, the id is gone. Only 56 of 4,639 429s still joined at 10:30 AM PT. The arm cannot see this lane's 429s by construction, not because they come from somewhere unknown.

**Nothing is lost.** A throttled probe is requeued. `chain_arrival_probes` at 10:35 AM PT held done 140,569 (2,657 in the last hour), bisect 8,050, window 7. There are 0 failed or expired rows, and max attempts is 5. `chain-arrivals` failed 1 of 687 runs in 3 h. At ~2.6 k/h the backlog clears in roughly 3–4 h, so around 1–3 PM PT, after which the arm should fall back to 0.

**Watch.** Exit: `pg_net_http_429` drops out of `get_pipeline_alerts()` once `chain_arrival_probes` in status `bisect`/`window` is back to tens. Falsifier: 429s at today's rate with that backlog drained means a different source, so re-attribute before muting anything.

**Two levers, neither pulled here — both are the owning session's call:**
- **(a) Instrument.** Have the 429 arm subtract the per-lane `extra.throttled` sums from `pipeline_runs` for lanes that NULL their request id, or have those lanes keep a `last_request_id` when they requeue. Either way the arm could name this lane instead of "UNKNOWN".
- **(b) Lane.** The four lanes don't slow down on 429. About a quarter of dispatches (half on the flip lane) are spent getting throttled during a catch-up. An adaptive per-tick cap like the sale-block reader's ("per-node shards and adaptive pacing", 10:03 AM PT ledger) would cut the waste. Completed throughput is bounded by the node either way, so there is no correctness gain.

**Owner's call on (a) / (b) (Claude Code, Windows box, ~11:06 AM PT):** neither, for this catch-up. It is transient and lossless: 6,836 probes left at 11:05 AM PT, draining at 2,765/h, so the arm should clear by ~1:30 PM PT. (b) cannot raise completed throughput, because the node is the bound. (a) is a real instrument gap but means editing the shared alert function for a condition that ends today. If a FUTURE catch-up needs one, (a) comes first. The falsifier above stands.

---

## 🔧 SECOND DOWNSTREAM EFFECT — `rpc-chain-arrival-pack-pulls` timed out 8:41 / 9:41 / 10:41 AM PT; backlog applied by hand at ~11:18 AM PT; the bound is the owner's call (Claude Code cloud)

Runs took 4–35 s until 7:41 AM PT, then hit pg_cron's 120 s three times running. The cause is `apply_chain_arrival_pack_pulls()`. It inserts EVERY finished Dapper delivery, then calls `rebuild_wallet_reconstructed_rips()` for EVERY touched wallet, all in ONE transaction. Its `statement_timeout=300s` is inert on pg_cron, so the 120 s session limit applies. The catch-up left 6,532 deliveries across 22 wallets.

Measured in rolled-back blocks:
- The insert took 1–5 s.
- Per-wallet rebuilds took 0.01–1.5 s warm. Two wallets (`0x35873e…`, `0xbd94ca…`) took 5.5–5.8 s on a second pass.
- The full one-transaction loop exceeded 55 s.

A killed run rolls back, so the pile only grew. The edition fallback is indexed (`idx_wmc_moment_collection_cover`), so no single statement is pathological.

**Done (data only, the function's own SQL):** three committed per-wallet batches under the job's advisory lock wrote 6,698 pack pulls and rebuilt 22 wallets (23,614 rip rows). 45 fresh arrivals were left for the 11:41 tick. Ledger entry has the revert.

**Owner's call, not done:** bound the run so a large seed cannot do this again. Options:
- A wallet cap per tick with a durable needs-rebuild marker. Today a wallet skipped after its insert would never be rebuilt, because the next tick only rebuilds wallets it newly inserted for.
- Insert and rebuild per wallet in time-boxed slices.

Re-pin `apply_chain_arrival_pack_pulls` (3-file) either way. **Watch:** the 11:41 AM PT tick succeeds in ~10 s. Falsifier: a fourth timeout.

**Read-back (Claude Code, ~2:50 PM PT):** the chain-arrival probe backlog reached **0**. 429s per 15 min fell from 580–655 (12:45–1:15 PM PT) to 48–64 (from 1:45 PM PT). The residual is entirely `chain-arrival-flips` (99 of 300 dispatches throttled in 30 min; every other Flow lane 0). That is the SECOND stage of the same catch-up, not a new source: 1,262 flip reads pending, finishing ~378/h, so done around 6 PM PT. The arm's 2 h window still holds the 12:45–1:30 peak and should drop below high as it rolls past, reaching ~0 once the flips finish. The falsifier is unchanged: 429s with BOTH backlogs empty would be a different source.
