# Daytime monitor — 2026-11-20 ~01:05Z — `compute-pinnacle-pack-ev` Atlas 403s still count as failed runs (the 11-19 "challenge = retry" fix skipped this lane)

**Source:** `rpc_ops_snapshot()` pipeline_alerts (the ONLY `severity: high` row this sweep) + `pipeline_runs` last-10 read, `compute-pinnacle-pack-ev`.

**Risk read:** LOW. Sense-only; no data loss and no user-facing staleness.

## What the instrument shows
- The snapshot's one HIGH failure_rate row: `compute-pinnacle-pack-ev` 5/9 runs failed (55.6%) over 3 calendar days; last error `atlas: SearchDistributions: HTTP 403 (cloudflare challenge) after 4 attempt(s)`.
- Last-10 runs read directly: the 5 failures are **four HTTP 530s** (11-18 06:17/12:17/18:17 + 11-19 00:17 — the recovering #218 Dapper Studio outage window) **plus one Atlas 403 cloudflare challenge** (11-19 12:17Z). The **newest run (11-19 18:17Z) is ok**.
- Pinnacle freshness is healthy: `pinnacle_fmv_stale_hours` 2.5 (ok), `pinnacle_render_floor_stale_hours` 3.5 (ok), `pack_ev_board_max_stale_days` 0.026 (ok). No downstream cost.

## Why it is still HIGH when the sibling #218-pooled rows streak-split to info
The 530 failures are the recovering Dapper window and will age out of the 3-day pool on their own (same as the other #218-pooled rows now reading info). The row stays HIGH because its most-recent failure (the 11-19 12:17 Atlas 403) is only ~13 h old.

## The durable, new part (what is actually worth a fix)
The 11-19 night-pass migration `20261119123000_audit_20261119_a_cloudflare_challenge_is_a_retry_not_a_failed_run.sql` reclassified Atlas 403/429 as `requests_challenged` (retry, run stays ok) for **pack-nft-identity and wallet-pack-pulls only**. `compute-pinnacle-pack-ev` was NOT included, so its Atlas `SearchDistributions` 403s still fail the run. Even after the 530 window clears, an occasional Atlas 403 (~5–15% base rate) will keep bouncing this lane into the failure-rate arm, the exact class that fix was built to stop.

## Suggested action (night pass / Trevor)
Extend the same `requests_challenged` treatment to `compute-pinnacle-pack-ev`'s Atlas leg: a 403/429 cloudflare challenge on `SearchDistributions` becomes a retry/`requests_challenged`, not a failed run; keep 5xx (the 530 Studio leg) and undecodable/Connect errors failing as now, and keep the 2-h-no-200 HIGH escalation. Mirror the pinned-test pattern from the 11-19 fix (planted defects: everything-a-challenge / nothing-a-challenge). Low-risk alerting-accuracy change; no pricing/ingest/public-read behaviour touched.

## NOT findings (recorded so they are not re-raised)
- `rpc-candy-wmc-ghost-purge` pg_cron failure (11-19 09:10Z, statement timeout): STALE pre-fix run. The fix `20261119110000` (duplicated-moments prefilter, 15.8 s) landed ~19:00Z 11-19, after the failure; next tick is 11-20 09:10Z. Expected to clear; focus.md already carries the falsifier read.
- All other failure_rate rows are the #218 530 window (streak-split to info) or designed Atlas/Flow cloudflare base-rate info rows. Security [], trust 41/41 ok, stalled [], UUID sentinel 0, 13/13 dashboards' objects resolve, Vercel newest BUILDING + rest READY (0 ERROR).
