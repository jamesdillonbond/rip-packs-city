# Handoff — 2026-09-20 overnight autonomous pass (Cowork cloud)

> ⚠ **Environment scope:** this pass ran in the Cowork cloud sandbox and was PUSH-CAPABLE via the `.rpc-git-cred` credential store (`git push --dry-run` exit 0). Trevor's machine and Claude Code push normally via Git Credential Manager — commit these files as usual.

**Real time:** DB `now()` 2026-09-20 08:03Z at start = ~01:03 AM PT. Genuine overnight window, shell clock matched DB (no skew). Lock taken (run-id np-20260920-sbx-26083), released at end. No FREEZE. No concurrent migrations landed in-window (`schema_migrations >= 20260920070000` = empty).

## Verdict: HEALTHY, no regression. Shipped 0.

Nothing net-positive + reversible was un-owned to ship. Every live lever is already tabulated in the ledger, is FMV/ingest-adjacent (off-limits to autonomous route changes), or is an explicit Trevor decision. A quiet honest night.

## Health sweep (`rpc_ops_snapshot` baseline + corroboration)

- **Security 4/4 clean:** invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Structural drift all clean:** function/procedure search_path drift [], txn-control pins [], backward_cursor_rewinds [], suppression_parked_claim_drift [].
- **Trust health:** all arms ok except `public_board_slow_count`=3 (BREACH). This is the known planner-prune instrument that lies (`SELECT count(*) FROM <view>` gets pruned). Corroborated against the real instrument — Vercel runtime logs: NO public-board 5xx storm. Genuine hard 5xx over 24h is tiny (503×81, 500×19, 504×16, all correlate with the morning IO spell). Not chased.
- **`trust_precompute_max_age_hours` 7.93** (ok, breach 13) — precompute fresh.
- **Sentinel** ts-uuid-editions-48h 0; cross-collection mats fresh ([]); sentinel TS edition leak clean.
- **Sentry:** 0 new issues in 24h. PAIRED with Vercel per discipline (a Sentry zero alone is a dark-reporter reading): Vercel top error route `/[collection]/pack/dist/[distId]` 2,100/24h — the chronic `[pack-detail] read exceeded 5000ms` family, all logged at HTTP 200 (soft). No group first-seen in 24h → **last night's 30 ships added no new error class.**
- **db 19,046 MB** — the 09-20 `net._http_response` VACUUM FULL reclaim (10 GB → 469 MB) is holding.

## Pipeline alerts (all chronic, on 2-day windows straddling the morning spell)

`backfill-pack-rip-metadata` 53% (see lever below), `allday-buyer-backfill` 31%, `fmv-backfill` 43%, `lock-check-batch` 40%, `run-insider-detectors` 41% (upstream request timeout — external), all `canceling statement due to statement timeout`. `pinnacle-metadata-backfill` cron_silent 223m but heartbeat firing at :22 (chronic cadence-only lane). Atlas 403s info-level (Cloudflare challenge, 0 sets incomplete >6h, market last-drain 08:03Z fresh). None new, none escalated.

## Post-ship watch — last night's 30 ships

VERIFIED landed:
- **daily-portfolio-snapshot** wrote **27 rows at 02:34Z** (pg_cron); the dedup scoping works — 06:46Z / 07:05Z ticks correctly wrote 0 (already snapshotted).
- **match-topshot-players** pg_cron (jobid 543, 07:32Z) and the 08:00Z edge tick both `ok=true`.
- **pack-rip 50 s function statement_timeout** (mig 20260920014006): falsifier CLEAN — recent failures are at **50.2 s, not 30.x s**, so the proconfig lever took effect. Remaining failures are the batch-cannot-finish-in-50s shape (writes 0 all-or-nothing) → the real fix is cutting items-per-tick, a route/function batch-size change ⇒ QUEUED (needs local test, off-limits unattended).

PENDING their tick clocks (re-check next pass):
- **jobid 324** `rpc-thp-leg-impossible-parallel` moved to `59 23,5,11,17` — first new-schedule tick **11:59Z (4:59 AM PT)**. The 06:31Z 608 s failure was the PRE-move `:31` tick (expected). Falsifier: a kill at `:59` with io_wait<3 = the leg's own cost.
- **jobid 506** confidence precompute drift-sample 1/64 (mig 20260920054402) — first post-fix tick **09:35Z (2:35 AM PT)** must read duration_ms < 90,000, efc_drift_sample_mod=64. The 05:35Z 203.8 s run was pre-fix.
- **r107 daily reconcile** 09:36Z — `check_edition_fmv_current_source_drift(1)` = [].
- **jobid 560** pack_rips autovacuum re-enable 08:12Z; ~1:30 AM PT map > 95%, no startup-timeout step.
- **pack-detail 5 s timeouts** expected to drop post ~1:30 AM PT once the pack_rips heap-fetch reduction lands.

## #126 advanced (read-only diagnostics — the live focus item)

The focus file's live steer is **#126: the cron fleet is ~10× busy-seconds at constant work since 09-15**, cause unproven. Re-measured after last night's 30 ships:

- busy-seconds/day: 09-15 **23,020** → 09-19 **233,894** → 09-20 (8 h partial) **82,387** (~24.1 s/run, essentially unchanged from 09-19's 24.6 s/run). **The 30-ship night did not move the fleet aggregate.**
- ~33% of busy-seconds is FAILED runs burning their full statement_timeout before dying.
- Decomposition (24h, top by busy-s) shows it is **not one regression** but a concentration:
  - **Atlas family ≈ 87k s/day:** `rpc-ts-listings-atlas-sync` 42,589 s (632 runs, 239 failed, avg 67.4 s) · `rpc-allday-unmapped-atlas-resolver` 20,478 s (95 failed) · `rpc-atlas-market-drain` 19,414 s · `rpc-atlas-editions-drain` 4,694 s.
  - **`rpc-refresh-wmc-fmv-changed`** (jobid 303) 28,311 s/day (144 runs, avg 196.6 s) — the #1 FMV reader, already flagged for Trevor.
- **R117** (wmc autovacuum ~3.4 h/day) is ONE contributor, dwarfed by jobid 303's read cost.
- **No clearly-safe autonomous lever:** every top contributor is owned, a Trevor decision, or a route/pipeline-logic change with documented invisible-failure history. QUEUED for Trevor as a product/architecture decision.

## Queued for Trevor

1. **#126 cron-fleet cost** — the atlas-sync family (~87k s/day) and jobid 303 `refresh_wmc_fmv_changed` (28.3k s/day, #1 FMV reader) are the drivers; both need a product/architecture call (cadence, batch size, or read-path redesign), not an autonomous lever.
2. **pack-rip backfill batch size** — the 50 s lever now aborts cleanly, but the batch still can't finish in-window during busy periods; cut items-per-tick (route/function change, needs local test).
3. Carried forward: #22 purge-residue GC+rotate · #55 both 2-hourly Routines disabled since 09-01 · retire `portfolios`/`portfolio_moments` (option b) now the grant is gone · Golazos Sales Ingest >168h warn threshold vs a ~10-day-gap market.

## Failed / reverted: none.

## Inbox

535 files in `docs/overnight/inbox/` (273 archived). The recent 09-19 evening candidates map to last night's 30 ships (anon-grant revoke, R107 reconcile, R115/R116 precompute, portfolio snapshot, atlas ts-listings). Not mass-archived this pass — `INDEX.md` carries CI assertions and archiving 500+ is out of scope for a nothing-shipped night; left for a hygiene pass.
