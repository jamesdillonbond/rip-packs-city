# rpc-chain-arrival-pack-pulls re-wedged — 16h apply stall, 4th consecutive night; prioritize the durable bound over another hand-drain

**Filed:** 2026-10-08T00:10Z · daytime health monitor (read-only) · NOT in a saturation spell (positive control io_wait 2 / active 8; rpc_ops_snapshot returned fast — the exact 120.0s timeouts are a true pg_cron statement-timeout wall, not spell collateral).

**This is an ESCALATION of an already-QUEUED item, not a new cause.** The durable bound for `apply_chain_arrival_pack_pulls()` is already queued (10-04 ledger entry; inbox `2026-10-04T1505Z`; night-pass handoffs 10-06 / 10-07). This filing only records that the 10-07 pass's own prediction — *"re-wedges on next 11:13Z seed, durable bound still queued"* — came true, with the measurement and the recurrence count, so the night pass can weigh shipping the bound against a 5th hand-drain.

## Observed (prod, read-only)
- `check_pgcron_recent_failures()` → `rpc-chain-arrival-pack-pulls` failed 21/24 in window; last_run 2026-10-07 23:41Z, `canceling statement due to statement timeout`.
- `cron.job_run_details`: the last **12 consecutive hourly ticks (12:41Z → 23:41Z)** each ran exactly **120.0s** and failed (rolled back). A timed-out tick commits nothing, so the pending pile only grows.
- Last applied chain-history pack-pull: `moment_acquisitions` `max(created_at) = 2026-10-07 08:22:48Z` = the night pass's 08:22Z re-drain (`applied_24h = 4,083`). No Dapper delivery has become a pack pull for **~16h**.
- `chain_arrival_probes` open (status NOT IN done/failed) = **0** → discovery is caught up; the wedge is purely the single-transaction insert + per-wallet `rebuild_wallet_reconstructed_rips` exceeding pg_cron's effective 120s. Same class as 10-04.

## Recurrence (Vercel prod commit log)
- 10-04 hand-applied 6,698 pulls / 22 wallets.
- 10-05 13 consecutive timeouts — inbox-filed by the daytime monitor.
- 10-06 21/24, ~31h lag — hand-drained 4,796 / 18 wallets.
- 10-07 re-drained 4,083 / 16 — handoff explicitly: *"durable bound still queued, re-wedges on next 11:13Z seed."*
- 10-08 (this run) re-wedged exactly as predicted.

**Four nights running** the lane wedges, the night pass hand-drains the data, reports GREEN, and the structural fix slips a night.

## Blast radius
Saved-wallet custodial pack-pull → `wallet_reconstructed_rips` / pack-history freshness only (~27–33 seeded/saved wallets). No site outage; no security/trust impact (snapshot clean, 0 breaches). Bounded and self-correcting once the run is bounded — every hand-drain shows the backlog applies cleanly in one pass.

## Risk read
Fix is LOW-risk but owner/night-pass lane (bounds a pg_cron'd data function; migration + pin). The daily hand-drain is a treadmill that hides a ~16h/day user-facing stall behind a GREEN headline.

## Suggested action (night pass / Trevor — NOT this monitor)
Ship the already-queued durable bound (per-wallet cap or time budget with a durable `needs_rebuild` marker so a partial run commits progress) **instead of** a 5th hand-drain. Acceptance: a `rpc-chain-arrival-pack-pulls` tick finishes well under the 120s wall on a full post-seed pending set, and `last_applied_pack_pull` stays within ~2h of now across the 11:13Z seed. Do NOT lengthen the function-header `statement_timeout` — inert under pg_cron (documented, measured 10-02/10-04).

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

FIXED 10-09 ~10:00 AM PT: the durable bound shipped (`20261009162222` + `20261009165544`) and the backlog drained in one 18.7 s run. See the ledger entry "`rpc-chain-arrival-pack-pulls` UNWEDGED".
