# RPC overnight autonomous pass — handoff · 2026-09-09

> WARNING — Environment scope: this was a cloud Cowork session in NO-PUSH MODE. git push was unavailable (mount remote.origin.pushurl is empty; no credential to harvest). This blocker is specific to this cloud session. Trevor's machine and Claude Code push normally. The one migration below was applied to prod via apply_migration (that does not go through git); its repo file is written but UNCOMMITTED — mirror to mount. Commit it as usual from the desktop.
>
> ✅ **CLOSED 2026-09-10 (~20:45 PT).** The migration file `supabase/migrations/20260909080921_retire_ingest_cadence_watchlist_row.sql` is committed on `main`, so the prod/repo drift window is shut. ⚠ **It had reached `main` by another session while a second, non-identical copy of the SAME version sat untracked on the mount** (longer header, `public.`-qualified; semantically identical) — the committed copy was kept and the mount copy discarded. Post-ship re-verified live: `detect_stalled_pipelines()` returns 1 row and `ingest` is absent, so the change is HOLDING. This pass also had **no ledger entry at all** until it was back-filled on 09-10; see the `2026-09-09 · ✅ Night pass (cloud, NO-PUSH)` entry.

Run: rpc-nightly-autonomous-pass · started ~01:03 PT (08:03Z) 2026-09-09 · genuine overnight window (DB now() 08:03Z, no clock skew vs sandbox) · lock taken, FREEZE absent.

Verdict: quiet, honest night. Estate green. One clean DB ship (a retired-lane false-stall flip). Nothing else was clearly-safe; everything else is known/attributed or queued.

## What was reviewed
- Continuity: ledger top matter (read from fresh clone = origin tip 7ecb6de7; mount is 3 commits behind, a clean ancestor), metrics-latest.json (last pushed 09-07), docs/overnight/focus.md (absent), today's daytime-monitor filing inbox/2026-09-09T0611Z-daytime-monitor.md (mount-only, the freshest candidate feed).
- Inbox: 417 un-archived files on origin (archival blocked on a push run — known since 09-07 ops_note). Folded the recent un-triaged filings; the single actionable new candidate is the one shipped below.
- Health: rpc_ops_snapshot() full vector + drill-downs; Vercel runtime errors (24h); check_cron_heavy_job_exec_drift(); post-ship watch on last night's #68 dedup.

## Health-drift findings
- Security: all four invariants [] (invariants, anon_write_holes, rls_off_base, secdef_anon). Clean.
- Trust health: 38/38 arms ok, trust_health_breaches []. trust_precompute_max_age_hours 5.29 (< 13 breach) so the board is fresh, not a refresher artifact. Sentinel TS-UUID editions 48h = 0. ts_uuid_dupes_created_24h 0.
- Stalled pipelines (pre-ship): 2 — topshot-catalog-backfill (known info seed, 2026-09-04) and ingest (medium, classification not_invoked, silent 1938m vs 1800m threshold). The ingest entry is the shipped fix. Post-ship: 1 (only the info seed remains).
- pipeline_alerts: all info / attributed — golazos resolving_editions; nfl_all_day unmapped backlog (37,022 actionable, ~27.8d to clear, by-design multi-NFT frozen); atlas-editions-upstream-403 (5.4%, request-id attributed CF challenge, freshness intact); atlas-market-upstream-403 (5.5%, same); flow-rest-moment-moved-400 (9.6%, designed borrowMoment panic). Nothing new.
- pipeline_fails_24h: all upstream:0 or known chronic classes — atlas-editions-refresh 46 / atlas-market-feed 36 (403-retry collateral), wallet-backfill 12 (Flow computation-limit on large collections, chronic), refresh_wmc_fmv_drift_active 8 (chronic ~2% lock timeout), sync-nba-projections 8 (#8, NBA offseason dry). No new class.
- cron_heavy exec drift: live check_cron_heavy_job_exec_drift() = inspected 58, offenders [] — clean. The one smoke-test HARD FAILURE in the error table (rpc-topshot-sales-atlas-backfill -> backfill_topshot_sales_from_atlas_events, last 2026-09-09T00:37Z) was a TRANSIENT during last night's grant-then-unschedule of jobid 481 (ledger 4fcf2a26 granted it, 6d42929 unscheduled it after its IO spell). The job no longer exists in cron.job; no SMOKE-TEST HARD FAILURE in the last 4h (grouped-count confirmed empty). Self-resolved — no action.
- Vercel: no deployment in ERROR (CANCELED ones are last night's superseded tight-session pushes + docs-only tips, expected). Runtime-error clusters all pre-existing honest-degradation classes (statement-timeout -> empty on edition/pack/insights panels; url.parse DEP0169 node warning, benign). No new class tied to a recent deploy.
- Post-ship watch — #68 dedup (shipped 09-08): HOLDING. Both per-partition unique indexes sales_2026_tx_nft_price_uidx / sales_2027_tx_nft_price_uidx are indisvalid; the dupe-watch cron job succeeded 03:38Z. No regression.

## Deltas vs metrics-latest (09-07 baseline; the 09-08 Claude Code work sits between)
- DB size 18,191 MB -> 22,834 MB (+4.6 GB). Largest mover. Consistent with the filed 2026-09-08T0015Z item (Atlas events table ~90k rows/day, 4 lanes reading it, no retention) partly offset by the 09-08 prune of topshot_atlas_market_events. Not an emergency on Pro, but the growth rate is worth a retention decision — QUEUED below, not shipped (needs a policy call + is bigger than a night-pass lever).
- Top Shot FMV (canonical 14,015 editions): HIGH 1,495 + MEDIUM 6,094 = 7,589 HIGH/MED ~= 54.2%, up from the 09-08 close read of 51.3% — the post-drain recompute continues to propagate (M1 bar is 50%). topshot_fmv_pct_stale_30d 0.0.
- editions_by_collection: nba_top_shot 14,015, nfl_all_day 6,190, laliga_golazos 575, ufc_strike 518, candy_mlb 125.

## SHIPPED (1 — DB only, within the 4-change cap)
### Retire the ingest cadence-watchlist row (permanent false medium stall)
- Migration: 20260909080921_retire_ingest_cadence_watchlist_row (applied via apply_migration; repo file written to supabase/migrations/ — UNCOMMITTED, mirror to mount).
- Change: guarded single-row UPDATE pipeline_cadence_watchlist SET is_active=false WHERE pipeline='ingest' (RAISEs unless exactly one active ingest row exists; appends a dated notes rationale).
- Why: the ingest lane was retired from rpc-pipeline.yml on 2026-09-07 (upstream decommissioned; sales now via sync_sales_from_atlas). Its last run is frozen 2026-09-07T23:46:57Z, so detect_stalled_pipelines() returned it medium FOREVER and the rpc-qa-scorecard stall card read RED permanently — a stall arm that can never clear masks a future real stall.
- Verification: post-ship ingest.is_active=false; detect_stalled_pipelines() dropped 2->1 and no longer contains ingest (only the long-standing topshot-catalog-backfill info seed remains). Independent fresh-context subagent re-ran the read and returned PASS. Repo grep confirms no test/route depends on the ingest row being active (supabase/tests/detect_stalled_pipelines.sql uses synthetic rolled-back fixtures; sentinel_ingest_watch and panini-ingest are unrelated objects).
- Revert: UPDATE public.pipeline_cadence_watchlist SET is_active=true WHERE pipeline='ingest';
- Metric to re-check next pass: detect_stalled_pipelines() length stays 1 (info seed only); the qa-scorecard stall card no longer reads a medium alert.

## QUEUED (not auto-shipped)
1. Atlas-events retention / DB growth (+4.6 GB since 09-07). topshot_atlas_market_events and siblings grow ~90k rows/day with 4 lanes reading them (filed 2026-09-08T0015Z). Needs a retention-window policy decision, and a bounded delete/partition-drop is destructive SQL — OFF-LIMITS for the night pass. Queue a ready migration once the keep-window is chosen.
2. best-offers break-on-error (filed 2026-09-07T0200Z): a chunk-loop break on error renders a missing offer as a dash — route .tsx/worker code, needs a push. 0 warns in 24h; close after a week of zeros or ship the diff from desktop.
3. ~19 anon-public soft-404 tabs (filed 2026-09-07T0330Z): product call + proxy.ts change — off-limits, needs Trevor.
4. sync-nba-projections dry >=72h (#8): 0 ok / 0 rows in 48h; most likely NBA offseason, not a broken lane. Re-confirm at season start rather than "fix".
5. Inbox archival (417 files) + metrics-latest.json staleness: both blocked on a push run. A desktop/Claude Code pass should archive docs/overnight/inbox/* and let this pass's metrics-latest.json reach origin.

## Needs Trevor (long-standing, unchanged)
- #55 — both 2-hourly Routines read enabled:false; one click on one machine (device consent). Still queued (8+ days).
- #22 — credential-purge GC + rotate-regardless (GitHub UI + secret rotation).
- M2 / All Day slide — M2 at 20.2% vs >=30% bar on a real numerator loss; the next probe is upstream coverage, not another pipeline read. Not a night-pass lever.

## Failed / blocked / reverted
None. No verification failed; no revert needed; shipping was not hard-stopped. One ship, well under the cap.

Files written this run (clone + mirrored to mount, all uncommitted — NO-PUSH): this handoff; supabase/migrations/20260909080921_retire_ingest_cadence_watchlist_row.sql; docs/overnight/ledger.md (new entry); docs/overnight/metrics-latest.json. Lock released.
