# Daytime monitor — 2026-09-01 ~21:11Z (14:11 PT)

Read-only ~3h health tick. **Not a spell** (io_wait 2 / active 2). Baseline `rpc_ops_snapshot()`, `detect_stalled_pipelines()` `[]`, `check_pgcron_recent_failures()` `[]`, and the consolidated `rpc-live-health` payload query all ran clean. **No new candidates** — every signal is known-class or already filed. Lock RELEASED (night pass 08:18Z), stale, not held.

## Health line
✓ security 0/0/0/0 (invariants/anon-write/rls-off/secdef-anon all `[]`) · trust 38 arms, 2 breaches both known-class · stalled `[]` · pg_cron `[]` · sentinel ts_uuid_editions_48h 0 · rpc-live-health payload OK (TS FMV H+M 8,054/19,771; freshness FMV 21:09Z / PackEV 21:07Z / offers 20:47Z — all <25min) · prod deploy READY (`fix(db): revert get_lock_check_batch` 20:39Z; two newer commits docs-only + CANCELED, no ERROR) · DB 14,265 MB.

## Known-class / already-filed — considered, NOT re-filed
- **`topshot_pack_reality_top_ev` board = 0 rows** while `pack_ev_latest` TS is healthy (1,210 rows, 61 positive-EV, fresh 20:25Z). **Fully known + already actioned** — filed 2026-08-30T2115Z and RESOLVED: the board is empty because no *live* TS pack is +EV (atlas `:25` writer's rows are all negative EV) and the revived historical rows carry NULL depletion (excluded by the view's `COALESCE(depletion_pct,100) < 90`, which ⛔ must NOT be relaxed). Its liveness arm was set `is_active=false` (option (b), migration `20260830225125`), which is why `public_board_empty_count` is **not** breaching today. Dark-by-design pending the TS 530 outage / Atlas migration or the depletion leg. Not re-filed.
  - ⓘ *Marginal cosmetic (night-pass optional, not a candidate):* the `rpc-live-health` artifact's hardcoded Section-3 `SURFACES` list still includes `pack_reality_top_ev`, so its dashboard banner renders a red "1 surface EMPTY — investigate" for this dark-by-design board. Harmless (board is genuinely empty, not wrong), but a future artifact edit could drop it from the list or badge it "dark-by-design" to match the deactivated liveness arm. Artifact repair is the night pass's job.
- **offers-sweep 36 fail / 36 ok + ingest 5 fail (24h)** — all `Top Shot GraphQL failed with 530` (dead-host `public-api.nbatopshot.com`, behind the `c8ac905` breaker). Known operator-blocked outage (Atlas migration queued). Interleaved ok runs keep offers/FMV fresh — no user-facing staleness (trust arms `candy_offers_oldest_active_hours` 2.3, `topshot_fmv_stale_hours` 0.2 all ok). Not new.
- **wallet-backfill 9 fail / 451 ok (24h)** — transient Flow Access API "Invalid Flow argument: failed to execute the script"; ~2% failure, self-recovering. Known transient class.
- **Trust breaches (2), both standing known-class:** `public_board_slow_count` = 1 (breach_at 1) — planner-pruned instrument, saturation collateral, standing do-not-flag. `unmapped_resolution_backlog_max` = 213 (breach_at 100) — structural AllDay permanent-unresolvable floor, **declining** (225→213 since the night pass); do NOT raise breach_at.
- **pipeline_alerts:** `fmv-backfill` 5/17 (29.4%) — trailing 2-day statement-timeout window, no new failures, ageing out (do NOT re-fix). `unmapped-sales-nfl_all_day` INFO — permanent multi-NFT-tx floor (~613d to clear), structural.
- `sync-nba-projections` 8 fails — known dead sports-proxy 403 (ESPN 530/403, measured dead), alerts suppressed.
- Sentry — no new/spiking unresolved issues in 24h; also standing dark since 08-18 (#34, operator/billing), so not conclusive. Not re-probed.

## Sweep coverage note
Not first-tick-of-day (14:11 PT) → Section 1a trust-health + cross-collection-refresh extras correctly skipped. `rpc-live-health` payload validated by running its consolidated query directly (all keys sane, `db_active` 0, FMV legs not skipped). Other active artifacts not individually payload-validated (Windows-path Artifacts dir not in the sandbox mount) — but the backing data layer they read (`rpc_ops_snapshot`, `check_pgcron_recent_failures`, board-liveness tables, `fmv_snapshots`/`editions`/`pipeline_runs`/`collections`, insights backing views) all returned successfully, so no schema break surfaced this tick.

---
_inbox written to mount, push unavailable (daytime monitor mount-write path). Night pass picks this up locally._
