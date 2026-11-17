# 🔴 HIGH — `rpc-chain-arrival-pack-pulls` is WEDGED: 10 consecutive hourly statement-timeouts, 0 deliveries applied in 11 h — the predicted recurrence of the unbounded per-wallet rebuild

*(daytime health monitor, 2026-10-05 ~21:06Z / ~2:06 PM PT. Read-only. Sense-only — not fixed here.)*

## What

The pg_cron job `rpc-chain-arrival-pack-pulls` (runs `apply_chain_arrival_pack_pulls()`, `41 * * * *`) **succeeded through 10:41Z today, then failed 10 consecutive hourly runs from 11:41Z through 20:41Z**, every one `ERROR: canceling statement due to statement timeout` inside the `WITH pulls AS (SELECT DISTINCT ON (ma.coll…` per-wallet rebuild. The lane is wedged: each failed run rolls back, so the pending pile only grows and the single-transaction rebuild gets larger and more likely to keep timing out (positive feedback).

## Source

- `check_pgcron_recent_failures()` → `rpc-chain-arrival-pack-pulls`, latest_status `failed`, last_run 2026-10-05 20:41Z, 10/24 fails in window.
- `cron.job_run_details`: succeeded 07:41/08:41/09:41/10:41Z, then **failed 11:41Z→20:41Z (10 in a row)**, identical statement-timeout message.
- `rpc_ops_snapshot()` `pipeline_fails_24h`: `chain-arrival-flips` 10 fails/24h (same lane).
- Corroboration: `moment_acquisitions` where `source='chain_history' AND acquisition_method='pack_pull'` — **last write 2026-10-05 00:41Z, 0 rows written in the last 11 h.** The lane has applied nothing since this morning.
- Prior art: ledger `2026-10-04` entry ("🗄 DATA (unblock, no code) — `rpc-chain-arrival-pack-pulls` timed out 3 hours…") + inbox `2026-10-04T1505Z-…`. That pass drained the backlog by hand, explicitly left the root cause as **"Not done (owner's lane): bound the run (wallet cap or time budget with a durable needs-rebuild marker), or the next large seed repeats this,"** and set the falsifier **"a fourth timeout."** We are now at ten.

## Risk read

- **This is the recurrence the 10-04 entry predicted, not that same transient** — so it is worth re-filing even though the shape is known. The root-cause fix was never shipped (it is the owner's lane).
- **Not saturation collateral** (Section 1c positive control at read time: `pg_stat_activity` io_wait 0 / active 0 / 28 total; `rpc_ops_snapshot()` returned fast). It is one job failing on one specific query — a genuine per-run-cost regression, not a spell symptom. Cause is safe to assert.
- **Blast radius:** chain-arrival Dapper deliveries (senders `{0xe1f2…, 0xb6f2…}`) are not being applied → `moment_acquisitions` pack_pull/`chain_history` inserts and `rebuild_wallet_reconstructed_rips` are stalled → affected wallets' pack-history "ripped" counts and reconstructed-rip valuations fall behind (the Rigged-class estate work). Data-freshness regression; **not** a security or public-surface outage. Security/trust/stalled/sentinel all clean this run.
- **Low-risk to fix** — the durable fix is already specified by the 10-04 entry; the immediate unblock is a proven hand-drain recipe.

## Suggested action (night pass / Trevor — sense-only here)

1. **Immediate unblock:** drain the accrued backlog by hand in committed per-wallet batches under the job's advisory lock, exactly as the 10-04 entry did (insert + `rebuild_wallet_reconstructed_rips(w)` per wallet, committed per batch so a timeout cannot roll back the whole pile).
2. **Durable (the open owner-lane item):** bound `apply_chain_arrival_pack_pulls()` to a per-tick wallet cap or time budget with a durable needs-rebuild marker, so the per-wallet rebuild loop cannot exceed pg_cron's ~120 s session timeout and the next large seed cannot re-wedge it. Size the cap off a quiet-window re-measure of the per-wallet rebuild cost.
3. **Falsifier that it is fixed:** the next hourly tick reads `succeeded` and `moment_acquisitions` `chain_history` writes resume (last was 00:41Z).

Dedup: same lane as `2026-10-04T1505Z-…` and the 10-04 ledger entry; re-filed because the root cause is still open and the wedge is live. Not on the Declined list (the fix is "owner's lane" = queued, not declined).

## ✅ RESOLVED (Claude Code, indexed 2026-10-09 ~11:00 PM PT)

FIXED 10-09 ~10:00 AM PT by `20261009162222` + `20261009165544`. The root cause was two costs: every run re-checked every done probe, and repeated rebuilds fell to a generic plan. See the ledger entry "`rpc-chain-arrival-pack-pulls` UNWEDGED".
