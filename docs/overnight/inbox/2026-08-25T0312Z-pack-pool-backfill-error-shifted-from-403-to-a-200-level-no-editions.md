# topshot-pack-pool-backfill: last error shifted from the ledger's documented 403 to a 200-level "no editions"

**Source:** rpc-daytime-monitor, 2026-08-25T03:12Z tick (late tick, not first-tick). Observed via `rpc_ops_snapshot()` `pipeline_alerts` + `pipeline_fails_24h`, cross-read against the ledger's jobid-16 history.

## What was observed (measurement, not conclusion)
- `topshot-pack-pool-backfill` (jobid 16 `rpc-backfill-pack-pool`, sync path `mode=pool&sync=1&limit=3&conc=1`): **224/225 runs failed (99.6%) over 2 days**, **259 fails in 24h** — the single largest failing pipeline on the board.
- Its **last error is now `0/3 dists converted; 3 returned no editions`** — a 200-level logic outcome, NOT the `{"error":"forbidden"}` / `pg_net_http_403` the ledger documents for this exact job (ledger ~13995 and ~15081, the 08-12/08-13 attribution work: "the historical backfill lane is dead" via a 403 on `backfill-topshot-pack-supply`).
- **Spell positive control at read time: `io_wait=0, active=0`** — NOT in a saturation spell, and the error is a logic message, not a timeout. So this is a genuine steady-state observation, not saturation collateral.

## Why this is worth a note (not an alarm)
The ledger's picture is that jobid 16's lane is "403-dead" and operator-gated on a key rotation. The live error is no longer a 403 — the sync path is reaching the endpoint (200) and simply finding no editions to convert. Two readings, and the monitor cannot discriminate between them read-only:
1. **Benign / expected:** the finite historical backfill has exhausted its convertible distributions (nothing left to pull), so every tick correctly returns "no editions." If so, the 99.6% "fail" is a mis-classified done-state and the row could be retired or its outcome re-mapped — the user-facing pack pool was already confirmed FRESH via the healthy `compute-topshot-pack-ev`/`compute-allday-pack-ev` lanes (ledger ~13997), and rpc-live-health `insights_counts` + freshness validated clean this tick.
2. **Regression:** the 403 got resolved but the conversion query now legitimately returns nothing it should be converting.

## Suggested action (night pass / Trevor — a decision, not a diagnosis)
In a quiet window, confirm whether jobid 16's "no editions" is **exhausted work** (-> retire the row or re-map its terminal outcome so it stops posting as a 99.6% failure and dominating the fail board) or a **real conversion regression**. Independently, the ledger's "403-dead historical lane" belief for this job is now stale and should be re-derived. **Risk read: low** — read-only observation; proposed changes are a watchlist/outcome-mapping tweak or a ledger correction, no user surface, no data mutation, no key handling here (that lane's 403 history is operator/secret-gated).

## Also swept this tick (all known / already-filed — continuity only, NOT candidates)
- **`public_board_slow_count = 4` (BREACH)** + the cluster of pg_cron `statement timeout` / `job startup timeout` fails (rpc-ccm-step2, rpc-refresh-new-collectors, rpc-refresh-challenge-costs, rpc-thin-sale-ask-disclosure-refresh, rpc-refresh-players-current-team, rpc-weekly-log-purges, rpc-thp-leg-pinnacle-fmv-share) = one root cause (SMALL-instance disk-IO budget). focus.md PRIORITY 3 bars new investigations into these. Positive control confirms not in a spell at read time.
- **`unmapped_resolution_backlog_max = 350` (BREACH, nfl_all_day)** — chronic; 47,149 actionable rows, draining net ~-25/day (out 103 / in 78 per 24h). Known.
- **`cross_collection_ts_set_overlap_mat` staleness / `rpc-ccm-step2` timeout** — ALREADY FILED today at `inbox/2026-08-25T0011Z-cross-collection-overlap-mat-is-51h-stale-and-no-standing-metric-watches-it.md`. Not re-filed.
- Security invariants all clean. Production deploy READY (`b3230e36`); newest deploy CANCELED is the expected docs-only ledger commit (vercel.json ignoreCommand). Sentry: 0 new, 0 escalating in 24h. rpc-live-health artifact validated OK (12/12 backing views return, FMV/pack-EV/offers freshness minutes-old).
