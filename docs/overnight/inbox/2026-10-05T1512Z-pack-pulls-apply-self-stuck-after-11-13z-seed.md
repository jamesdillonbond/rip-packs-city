# Daytime monitor candidate — 2026-10-05T1512Z

Source: rpc-daytime-health-monitor (read-only sweep). Run HEALTHY overall — security 0/0/0/0,
trust 38/38 ok (0 breaches), stalled [], sentinel TS-UUID-48h 0, cross-collection refresh fresh
(step1 10:02Z + step2 10:35Z both succeeded today), Vercel no ERROR (today's CANCELED rows are
docs-only commits via the ignored-build-step; both code deploys READY), Sentry 0 new / 0 escalating
24h, FMV dashboards validate incl. the new NO_DATA bucket. NOT in a saturation spell (pg_stat_activity
io_wait 0 / active 0; rpc_ops_snapshot returned promptly). One live item below.

## 1. [KNOWN — live recurrence] rpc-chain-arrival-pack-pulls self-stuck since today's 11:13Z seed (apply lane does NOT self-recover)
- **This is the already-filed owner's-lane item, not a new bug.** Ledger 2026-10-04 line ~78 and
  inbox/2026-10-04T1505Z-… ("SECOND DOWNSTREAM EFFECT"): `apply_chain_arrival_pack_pulls()` inserts
  every finished Dapper delivery then rebuilds every touched wallet in ONE transaction; its
  `statement_timeout=300s` is inert on pg_cron so the 120 s session limit applies, and a killed run
  rolls back so the pending pile only grows. The filed-but-unshipped fix is to BOUND the run (per-tick
  wallet cap with a durable needs-rebuild marker, or time-boxed per-wallet slices) and re-pin (3-file).
- **New state today (what the 08:22Z night pass could not have seen — the lane started failing after it):**
  `cron.job_run_details` for `rpc-chain-arrival-pack-pulls` (hourly :41) over 24h = 17 succeeded /
  7 failed; **last success 10:41Z, then 11:41 / 12:41 / 13:41 / 14:41Z all `canceling statement due to
  statement timeout`** (last fail 14:41Z). The daily seed `rpc-chain-arrivals-seed` ran at 11:13Z and
  created fresh work; the unbounded apply has been stuck on it for the last ~4 hourly ticks. Unlike the
  seed (which self-recovers next tick), this apply lane does NOT self-recover — the 10-04 episode needed
  a hand-drain. So it will stay stuck until drained or bounded.
- **Impact:** LOW–MEDIUM and bounded. Recently-arrived custodial Dapper pack-pull deliveries are not
  being applied to `moment_acquisitions` / `wallet_reconstructed_rips`, so affected wallets' pack
  history lags until the lane drains. No outage, no correctness/accuracy-gate effect.
- **Suggested action (night pass / Trevor):** hand-drain the current pending set in committed per-wallet
  batches under the job's advisory lock exactly as on 10-04 (ledger revert block names the method), AND/OR
  finally ship the bound so the next seed can't do this again. Monitor sensed and logged only — no fix
  attempted (read-only pass). Do NOT re-investigate the cause: it is established (unbounded one-txn rebuild
  > 120 s); the only open work is the bound + the hand-drain.

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

FIXED 10-09 ~10:00 AM PT by `20261009162222` (per-probe checked marker + time budgets + rebuild queue) and `20261009165544` (`plan_cache_mode = force_custom_plan`); the backlog drained in one 18.7 s run. See the ledger entry "`rpc-chain-arrival-pack-pulls` UNWEDGED".
