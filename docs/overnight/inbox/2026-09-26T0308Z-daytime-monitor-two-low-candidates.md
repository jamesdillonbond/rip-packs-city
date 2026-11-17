# Daytime health monitor — 2026-09-26T0308Z (~8:08 PM PT tick)

Read-only sweep. Overall health **GREEN**: security 4/4 clean, trust_health 38/38 ok, stalled_pipelines [], pgcron failures [], sentinel_ts_uuid_editions_48h 0, all structural-drift arms []. rpc_ops_snapshot() returned fast (NOT a saturation spell). Latest prod deploy READY (2a0685fc). Sentry 0 new-in-24h (paired with Vercel = healthy). Two HIGH pg_net arms (400×1, 404×50 in 2h) both dispositioned as known/designed, NOT breakage — see notes. sync-nba-projections upstream failure already dispositioned (known-issues #8, inbox 2026-09-26T0006Z). player-stats-sync ESPN-500-stuck-at-queue-head already being fixed by an active concurrent session (migration 20260926025347).

Two NEW low-risk candidates below.

---

## Candidate 1 — [LOW] player-stats-sync: within-batch duplicate keys trip "ON CONFLICT DO UPDATE cannot affect row a second time"

- **Source:** pipeline_runs `player-stats-sync` 2026-09-25 23:49:09Z (8/8 chunks failed) + 23:51:13Z (4/4 chunks failed). Error: `chunk: route POST: HTTP 500 upsert: ON CONFLICT DO UPDATE command cannot affect row a second time`. Route: `app/api/cron/player-stats-sync` (upsert into `player_season_stats`).
- **Status:** SELF-CLEARED — every run since 00:04Z is ok=true (~14 runs; one unrelated external ESPN 504/500 transient at 01:38Z). Not currently broken.
- **⚠ Active concurrent development this hour:** the stats feed is being rewritten by Claude Code session_014mcifTeWvorofFKKT2CyWv (Opus 5.5) — migration `20260926025347` "fix(stats-feed): a failed ESPN fetch leaves the queue head" deployed READY ~02:53Z, plus a burst of candy/stats commits 02:50–03:05Z. That fix targets queue ORDERING (a 500'd player stuck at the NULLS-FIRST head), NOT within-batch dedup, so the two failures above are a distinct class, but the subsystem is in flux.
- **Risk read:** low. The Postgres error means a single upsert batch contained ≥2 rows with the same ON CONFLICT key. A within-chunk DISTINCT ON the conflict key before the upsert is additive and safe.
- **Suggested action (night pass):** FIRST re-check whether the active session's changes already resolved it (re-read recent player-stats-sync runs + the route's current upsert). Only if it recurs: dedupe rows on the conflict key within each chunk before the ON CONFLICT upsert in the player-stats-sync route. Do NOT race the active session — defer if the code is still moving.

## Candidate 2 — [LOW] storefront-reconcile lanes co-fire at :19:01, sharing QuickNode's 100/sec limit

- **Source:** pipeline_runs 2026-09-25 23:19:01Z — `allday-storefront-reconcile` (333 seller walks failed) and `golazos-storefront-reconcile` (79 failed) BOTH started at exactly 23:19:01Z, both failing HTTP 429 `100/second request limit reached ... quicknode` on the seller-walk leg.
- **Status:** SELF-RECOVERED on the next tick; single co-firing collision, not persistent — every other tick in the trailing 18h is errs=0. Both lanes still made partial progress in the failing tick (allday updated 4909 / inserted 2137; golazos updated 1928).
- **Risk read:** low. Cron stagger only (per docs/operations/cron-schedule.md); no code/logic change. The two lanes hitting QuickNode's shared 100/sec plan limit at the same second is the whole cause.
- **Suggested action (night pass / Trevor):** stagger the two storefront-reconcile schedules so they no longer both fire at :19:01 (move one off the shared minute). Alternatively bound each walker's request rate. Minor coverage loss (one tick) when they collide.

---

_Monitor notes (context, not candidates): pg_net_http_400 is a steady chronic baseline (~50–130/hr all day, designed Flow borrowMoment-panic / GraphQL-validation class). pg_net_http_404 "NoSuchKey" is the known sparse-dead-art-URL class (known-issues ~L1778), intermittent when the art-hydration lane runs (0 for 21:00–00:00Z, 10 at 01:00Z, 40 at 02:00Z) — not a spike. DB 26027→27548 MB is net._http_response TOAST refill (documented, expected to plateau ~12 GB; do not chase). panini-team-walk MEDIUM alert = R124 pooling-across-recovery (only failure 09-24 22:18Z, all green since)._

_Delivery: inbox written to mount, push unavailable (remote.origin.pushurl empty; remote.origin.url carries no token — no authenticated URL to harvest, per the pushurl-only path). Concurrency lock was RELEASED (stale from 09-25 08:15Z), so the commit was not skipped for lock reasons; it was skipped for lack of a push credential. The night pass picks this file up locally._

---

## Disposition — Claude Code, 2026-09-26 (~morning PT)

**Both candidates RESOLVED upstream; no action taken.** Re-derived against `pipeline_runs` since 00:04Z (row text matched, not a status field):

- **C1 — player-stats-sync duplicate keys: RESOLVED by `4ea939c5e`** (migration `20260925235606`, landed minutes after the 23:49Z/23:51Z failures). It re-keyed `player_season_stats` by team — a traded season is one ESPN line per team plus an `is_total` row — which is exactly the within-batch key collision the error names. Since then: **24 runs, 23 ok, 0 "cannot affect row a second time"** (the one non-ok run is the external ESPN transient noted above). No within-chunk DISTINCT needed.
- **C2 — storefront-reconcile co-fire: RESOLVED.** The two lanes no longer share a minute: live runs start at **:13 (All Day)** and **:43 (Golazos)**, 30 min apart. **7/7 ok each, 0 QuickNode `100/second` 429s** since 00:04Z.
