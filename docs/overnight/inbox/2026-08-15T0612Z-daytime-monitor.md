# Daytime monitor — 2026-08-15T06:12Z (off-hours, 23:12 PT Aug 14)

Shell down (7th night, `/sessions` no-space) → **inbox written to mount, push unavailable**. Lock RELEASED (night pass 05:16Z). One new candidate; everything else this sweep was already-known / operator-gated and is NOT re-logged.

## Sweep result: ✓ healthy-with-known-saturation-noise
- **Security 4/4 clean** (invariants / anon_write / rls_off / secdef_anon all `[]`). DB 12,921 MB.
- **Deploys clean** — tip `15c7dc4f` (retire tautological Pinnacle drift guard) BUILDING normally; recent history is a busy CC session (many CANCELED = superseded rapid pushes, several READY); **0 ERROR**.
- **Trust: 3 breaches, all known-class** — `panini_sale_price_capture_dry_days` 17 (home-box runner), `public_board_slow_count` 6, `unmapped_resolution_backlog_max` 254. No new/other breach.
- **Sentinel TS UUID editions 48h = 0**; `ts_uuid_dupes_created_24h` 0.
- **Loud pipeline alerts — all already ledgered 08-14, operator-gated, NOT re-logged:** `pg_net_http_403` CRITICAL (one job, jobid 16 `rpc-backfill-pack-pool`/`backfill-topshot-pack-supply`; blocked on 1 `*_GATE_KEY` + `--no-verify-jwt --import-map` deploy; blast radius = `gql_historical` pack-pool lane only, live `gql` lane healthy); `compute-pinnacle-pack-ev` 100% fail (`bd53bb3a` NEVER deployed per `extra ? 'dist_dupe_count'` = false on 10 recent runs; edge-fn deploy owner-gated); `topshot-active-listings-ingest` egress_blocked (atlas-proxy planned); `refresh_wmc_fmv_changed`/`_drift_active` (dual-scheduler, filed `d2ea70b8`).

## NEW candidate (low priority, likely self-healing)

**Title:** pg_cron statement-timeout cluster during the 08-14→15 saturation window left `cross_collection_cohort_mat` 26h stale.

**Source:** `check_pgcron_recent_failures()` — 7 heavy MV/aggregate refreshes all failed their most-recent run with `canceling statement due to statement timeout`:
`rpc-ccm-step1` (08-15 04:10, `INSERT … cross_collection_cohort_mat`), `rpc-refresh-new-collectors` (mv_ts_buyer_first_buy), `rpc-refresh-misattrib-candidates`, `rpc-refresh-challenge-costs`, `rpc-pinnacle-fmv-recalc-backstop`, `rpc-thin-sale-ask-disclosure-refresh`, `rpc-reconcile-saved-wallet-stats` (all 08-14). Each `fails_in_window=1 / runs_in_window=1` → infrequent jobs whose single recent tick timed out.

**Measured impact:** `cross_collection_cohort_mat` freshest `2026-08-14 04:10`, **age 26.0h**, 179 rows — the step1/step2 split (step2 `cross_collection_ts_set_overlap_mat` succeeded, 1.8h fresh, 259 rows) that SKILL §1a watches for. Backs the rpc-cross-collection artifact + cross-collection surface. Marginally over the 26h bar; not user-facing severe.

**Risk read:** LOW / self-healing. Same **IO-budget root cause** already under active CC work (the two heaviest disk readers — `backfill_wmc_fmv_confidence` #1 unscoped `ad18dfee`, `idx_wmc_wallet_collection` dropped `eaa23925`, `refresh_wmc_fmv_changed` #2 characterized) landed 08-14; the night pass notes the 08-14 saturation spike self-recovered by 08-15. These 7 timeouts coincide with the tail of that spike. `cross_collection_cohort_mat` refreshes at the next 04:10 tick and should self-clear if saturation stays eased.

**Suggested action (night pass / owner):** (1) If `cross_collection_cohort_mat` is still >26h stale at the next sweep, run the SKILL §1a recovery recipe — a self-cleaning pg_cron one-shot for **step1 only** whose body ends in `cron.unschedule` of itself (a FAILED one-shot does NOT self-unschedule → clean up next day). (2) The durable question is a **freshness-vs-IO tradeoff**: 7 heavy full-MV refreshes clustering their timeouts in the same window suggests they should be staggered off each other and/or the peak, or converted to incremental refresh — but that is downstream of the ongoing IO-budget work, not ahead of it. Do NOT treat any single timeout as a new incident while the readers are being drained.
