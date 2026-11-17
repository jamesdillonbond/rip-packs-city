# Daytime monitor — 2026-10-06T15:10Z inbox (read-only pass)

Lock was RELEASED (08:33Z, stale) so this file is committed. Positive control at 15:04Z: `io_wait=0, active=2` — NOT a saturation spell, so the findings below are genuine, not spell symptoms.

## 1. [HIGH · NEW] topshot-sellback-walk: 322 ticks failed today on a NOT NULL `nft_id` violation — a fresh regression that began 2026-10-06

- **Source:** `pipeline_runs` (pipeline='topshot-sellback-walk'); error `null value in column "nft_id" of relation "topshot_sellback_*"` (relation name truncated in the log). Last fail 15:07Z.
- **Measured:** 24h window = 1118 ok / 322 failed. The `nft_id`-null failures are ALL dated 2026-10-06 (322) with ZERO in the prior 6 days — a clean step-change that started today. Not on the ledger or the Declined list. upstream=0 (not an upstream 403), not a spell.
- **Risk read:** read-only to investigate = low risk. The regression itself is MEDIUM–HIGH impact: every failed tick's sell-back row that has a null `nft_id` is dropped (the NOT NULL abort rolls back that tick's insert), so some Top Shot sell-back/burn events are not being recorded, while 1118/1440 ticks still succeed. Logic/data-shape regression.
- **Suggested action (night pass):** find what changed on/around 2026-10-06 that lets a sell-back row reach the insert with `nft_id` NULL (candidate: the 2026-10-03 #167 follow-on "edition from a chain read of Dapper" sell-back lane, or an upstream payload-shape change). Then either guard/COALESCE `nft_id` at the walk's insert or skip-and-log genuinely null rows so the tick commits the rest. Acceptance: the `nft_id` error count falls to 0 on subsequent ticks.

## 2. [HIGH · CORROBORATION of an already-tracked item — NEW evidence only, do NOT re-file as new] rpc-chain-arrival-pack-pulls re-wedged within ~3h of last night's hand-drain

- **Source:** `cron.job_run_details` (job 'rpc-chain-arrival-pack-pulls'); `check_pgcron_recent_failures()`. ERROR `canceling statement due to statement timeout` on the `WITH pulls AS (SELECT DISTINCT ON ...)` apply query.
- **Already tracked:** logged 2026-10-05 (inbox `2026-10-05T2106Z` "wedged 10 consecutive timeouts", `2026-10-05T1512Z` "pack-pulls-apply self-stuck") and again 2026-10-06 by a prior monitor (commit a06fb6e2 "wedged 13 consecutive 120s timeouts — the 10-04 recurrence"); the overnight pass hand-drained it (c48f54c69 — 4,796 deliveries/18 wallets) and QUEUED the durable bound-task fix for Trevor.
- **NEW evidence this pass:** the hand-drain held only ~3 ticks. Of the last 26 hourly runs, 23 failed at a flat 120.0s ceiling; the only 3 successes (08:41/09:41/10:41Z, 8–10s each) were the empty-backlog window right after the 08:33Z drain, then it re-wedged from 11:41Z onward. The manual drain is not even a same-day stopgap: the job finishes only when the pending set is near-empty and cannot drain a real backlog inside pg_cron's 120s.
- **Risk read:** the fix is the queued durable task, not another hand-drain. Blast radius: chain-arrival Dapper pack-pull deliveries stop being written between manual drains; attribution/freshness lags and the backlog is rebuilding now.
- **Suggested action (night pass / Trevor):** prioritize the already-queued durable fix — chunk `apply_chain_arrival_pack_pulls()` into bounded batches with a cursor (commit per batch) and/or raise this job's statement_timeout, so a non-empty backlog drains across ticks instead of rolling back whole. Hand-draining again will re-wedge the same day.

---
Sweep: security clean · trust 38/38 ok (first-tick) · cross-collection refresh fresh + both steps succeeded (first-tick) · stalled [] · sentinel 0 · Vercel no ERROR (latest READY) · Sentry 0 new/escalating 24h. Upstream 403s (atlas editions/market/pack-supply) all info, retries keeping up, freshness current. panini-collector-walk 10-min cap + atlas-edition-supply failure_rate + flow-moment-moved-400 + unmapped-sales = known/by-design per focus.

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

(1) The sellback burst self-resolved 10-06 15:45Z (ledger 10-07 QUEUED entry). `20261009162520` now re-queues a 200 page that carries an id-less event instead of reading it partially; the walk itself finished and unscheduled itself 10-08. (2) The chain-arrival wedge was FIXED 10-09 ~10:00 AM PT (`20261009162222` + `20261009165544`).
