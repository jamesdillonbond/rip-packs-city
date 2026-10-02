# Daytime monitor — 2026-10-01 (evening tick, ~20:2x PT Sep 30)

Read-only health pass. One new candidate. Positive control clean (pg_stat_activity io_wait=0, active=0) — NOT a spell, so the causal reads below stand.

## Candidate 1 — HIGH — trust-health arm `topshot_impossible_parallel_serials` is BLIND (999 sentinel); underlying data is CLEAN (0). Month-boundary baseline gap.

- **Source:** `rpc_ops_snapshot()` → trust_health_breaches = [`topshot_impossible_parallel_serials`]; value 999, breach_at 3, status BREACH. NEW since 09-30 (that nightly recorded "trust 38/38 ok"). This is NOT the known-tracked `ts_uuid_dupes_created_24h` breach (that reads 0/ok). Not on the Declined list; not a current ledger item. (known-issues #82 was CLOSED 09-23 at "0 daily".)
- **Mechanism (measured, not guessed):** the leg `rpc-thp-leg-impossible-parallel` (jobid 324, schedule `52 1,7,13,19`) computes Σ closed-month baselines — "must be complete, else 999" — plus a live-month probe (ledger 2026-09-20, migration `20260920151857`). `rpc_impossible_parallel_baseline` currently holds **80 rows, 0 nulls, latest period_start = 2026-08-01**. It is now October, so **2026-09 (September) is a closed month with NO baseline row** → the completeness check fails → the leg writes its **999 sentinel**. jobid 324 ran 2026-10-01 01:52Z "succeeded, 1 row" and stored value=999 in `rpc_trust_health_precompute` (row is FRESH, 1h13m old — so this is the computed sentinel, not a stale-precompute artifact).
- **Why September is absent:** the daily rotation `rpc-impossible-parallel-baseline-rotate` (jobid 575, `22 19 * * *`, last ok 09-30 19:22Z) refreshes EXISTING rows stalest-first inside a 420s budget; it does not INSERT a row for the newly-closed month when the month rolls over. The 09-20 seed covered 2020-01 → 2026-08 (80 months); nothing has added 2026-09.
- **Blast radius:** monitoring-blindness only. Ran the leg's own editions×sales join live (NBA Top Shot, external_id ~ '::', circulation_count>0, serial_number>circulation_count): **0 impossible_sales, 0 distinct_editions**. No user-facing data is wrong.
- **Risk read:** LOW data risk / MED-HIGH monitoring risk — a genuine impossible-parallel regression would be masked by the stuck 999 until the Sept gap is closed, and this will recur at every month boundary.
- **Suggested action (night pass / Trevor — sensing only, I do not ship):** seed a `2026-09-01` baseline row (add the Sept period_start then run `rpc_impossible_parallel_refresh_stalest_baseline`, or the rotation's refresh path for the just-closed month), AND make the rotation upsert the newly-closed month at each boundary so it does not recur monthly. Verify: `SELECT * FROM v_rpc_trust_health WHERE metric='topshot_impossible_parallel_serials';` → status ok (true value 0).

## Not re-filed (already known / by-design / self-resolved):
- panini-collector-walk `usernotfound` (failure_rate medium) — already logged 2026-09-30T1509Z.
- pg_net_http_429 ~3154/2h (arm label high) — KNOWN: Flow envoy limiter; lane-stagger shipped 09-30 (`20260930143000`), "429 lane hygiene" carried in the 09-30 handoff. Volume still elevated post-stagger (the fix spread the burst across the minute; total rate is limiter-bound) — night pass to confirm burst reduction, not a new item.
- pg_net_http_403 x2 (arm label critical) — Cloudflare "Just a moment" challenge body, 2 calls/2h; upstream/self-inflicted noise, not attributable to any edge fn (net._http_response has no url), not actionable.
- security invariants `scratch_low_bt` / `scratch_snapmap` (RLS off) in the 03:03Z snapshot — both already DROPPED (`to_regclass` null for both); transient, clears on the next snapshot. anon_write_holes [] and secdef_anon [] throughout.
- atlas-editions-403 / atlas-market-403 (retry + freshness both fine), flow-rest-moment-400 (sold/moved moments, by design), unmapped-sales nfl_all_day (~5d to clear, by design) — all info.

## Health line
security clean (transient scratch tables gone) · trust 37/38 (1 breach = blind arm above, data clean) · pg_cron [] · stalled [] · sentinel ts_uuid 48h 0 · Vercel no ERROR (1 BUILDING + 2 CANCELED = rapid-push supersession) · Sentry 0 new/24h · 11 live artifacts enumerated, backing data layer spot-checked healthy (tracked-fmv 20, rewards_economy 1, pack_lifecycle_global 1, panini squeeze 5137 / special-serials 13017) · DB 30,099 MB.

_Filed by the daytime health monitor. Push route unavailable (no pushurl token on the mount — NO-PUSH MODE); written to mount, the nightly pass picks it up locally._

---

## ✅ Disposition (Claude Code, 2026-10-02 ~7:25 AM PT): resolved, and the recurrence is fixed. The filed mechanism was wrong.

- **Already healed when read.** The 2026-09 baseline row was written at 12:22 PM PT 10-01 (value 0, 4,365 ms) by the normal rotation. `v_rpc_trust_health` reads `topshot_impossible_parallel_serials` = 0 / ok.
- **The rotation does insert new months.** `rpc_impossible_parallel_refresh_stalest_baseline` puts a month with no row first (`ORDER BY b.computed_at NULLS FIRST`) and upserts it. Nothing was missing from it.
- **The real defect:** from midnight UTC on the 1st until the first rotation at 19:22Z, the leg's completeness check fails. So three ticks (01:52, 07:52, 13:52Z) published 999 every month.
- **Fix shipped:** migration `20261002142107`. When only the just-closed month has no row yet, the leg counts that month live. An older gap still publishes 999. The pinned test has the boundary case and the older-gap control, and the new assertion fails against the old body (planted-defect check). Live run after apply: 0 in 617 ms.
- **Exit:** on 11-01 the 01:52, 07:52 and 13:52Z ticks write a value other than 999.
