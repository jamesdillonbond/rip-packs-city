# Daytime monitor candidate — 2026-10-05T1809Z

Source: rpc-daytime-health-monitor (read-only sweep). Run HEALTHY overall — security 0/0/0/0,
trust 38/38 ok (0 breaches), stalled [], sentinel TS-UUID-48h 0, ts_uuid_dupes_24h 0, cross-collection
refresh fresh, DB 32,886 MB. NOT in a saturation spell (pg_stat_activity io_wait 0 / active 5;
rpc_ops_snapshot returned promptly). Artifact backing layer validated (snapshot view families +
probes on v_rewards_economy / v_rewards_user_balances / v_topshot_pack_lifecycle_global /
v_topshot_pack_realized_ev / v_tracked_wallet_fmv_confidence / panini_squeeze_totals+board /
get_active_challenges all resolve). Vercel: latest code deploys READY (BxonUaB5 allday-lock-refresh,
2LJtdt1Q panini NO_DATA); today's CANCELED rows are docs-only commits via the ignored-build-step.
One NEW candidate below; one KNOWN item still live (not re-filed).

## 1. [NEW — low/med] topshot-pack-supply-backfill: 100% failed (HTTP 530) on every run since 2026-10-03
- **Source:** pipeline_runs / rpc_ops_snapshot pipeline_alerts (failure_rate HIGH: "5/5 runs failed
  (100.0%) over the last 3 calendar days. Last error: HTTP 530"). Raw runs, all ok=false / err "HTTP 530":
  2026-10-03 03:10Z, 03:36Z, 08:15Z; 2026-10-04 08:15Z; 2026-10-05 08:15Z. Daily lane (~:15 past 08Z)
  making ZERO progress for 3 days.
- **Read (not in a spell — positive control clean, so this is interpretable):** HTTP 530 is Cloudflare
  "origin unreachable", which is DISTINCT from the 403 *challenges* the LIVE topshot-pack-supply-atlas
  lane absorbs (that lane is healthy — last 200 at 18:02Z; atlas-pack-supply-upstream-403 row is info).
  A 530 on only the backfill endpoint points at an endpoint/route/host that is down or has moved for this
  historical lane, not the shared Cloudflare challenge. Not in the ledger, focus do-not-flag, or inbox.
- **Risk:** LOW–MEDIUM. Backfill (historical pack-supply) only; the live supply lane is healthy, so no
  user-facing, FMV, or accuracy-gate impact. Cost is only that historical pack-supply coverage stops
  advancing while this is dark.
- **Suggested action (night pass / Trevor):** check whether the backfill's upstream endpoint/route is
  stale (530 = origin down → a dead host, or a route the lane still calls that has moved) vs transient
  Cloudflare; if the route moved, repoint it; if the endpoint is genuinely gone, decide whether the
  backfill is still needed given the live lane covers steady-state; if it is transient, add a retry/backoff
  so a 530 day doesn't read as a 3-day silent 100% failure. Monitor sensed and logged only — no fix
  attempted (read-only pass).

## Context — KNOWN items still live (NOT re-filed; here for night-pass continuity)
- `rpc-chain-arrival-pack-pulls` statement-timeout is STILL failing (hourly :41; 24h = 17 succeeded /
  7 failed; last success 10:41Z, last fail 17:41Z). This is the already-filed owner's-lane item —
  inbox/2026-10-05T1512Z-pack-pulls-apply-self-stuck-after-11-13z-seed.md and ledger 2026-10-04 (~line 78):
  the unbounded one-transaction apply+rebuild exceeds the 120 s pg_cron limit after today's 11:13Z seed,
  does NOT self-recover, and needs a hand-drain and/or the bound. No new action — see that filing.

(No other new candidates: atlas-edition-supply / panini-collector-walk failure_rate, pack-mint-probes,
the Atlas 403 info rows, and the Flow payload-convert pg_net_http_400 are all on the focus do-not-flag
list or already filed.)

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

RESOLVED 10-09 ~10:00 AM PT: `public-api.nbatopshot.com` answers HTTP 530 / Cloudflare 1033 (origin tunnel gone) from the DB itself, so pg_cron jobid 15 was deactivated (`cron.alter_job(active := false)`, not unscheduled). Top Shot `pack_distributions` stays current from other writers and `rpc-topshot-pack-supply-atlas`. See the ledger entry "`rpc-chain-arrival-pack-pulls` UNWEDGED" (item P3).
