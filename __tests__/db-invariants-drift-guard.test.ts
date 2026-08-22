import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// The supabase/tests/*.sql DB-invariant tests embed a VERBATIM copy of the
// function-under-test's DDL so they run self-contained on a vanilla Postgres
// (no full-schema apply). That copy is only meaningful if it stays identical to
// the committed migration — otherwise the DB tests would validate stale logic.
// This guard extracts the function's DDL from both the SQL test file and its
// source migration, normalizes whitespace, and asserts they match. It needs no
// database, so it runs in the ordinary (blocking) unit-tests job even though the
// DB tests themselves run in the separate, initially-non-blocking db-tests job.

const root = process.cwd()

const PINS = [
  {
    // Added 2026-08-20. A live deleter with THREE DELETE legs that had NO
    // migration anywhere in the repo — prod carried DDL the repo could not
    // describe. The snapshot migration was created for it in the same pass.
    fn: "prune_log_tables",
    test: "supabase/tests/prune_log_tables.sql",
    migration: "supabase/migrations/20260820190000_audit_20260820_snapshot_prune_log_tables.sql",
  },
  {
    // Added 2026-08-20 by the completeness arm below, which found it: this file
    // carried a verbatim copy and was in NO drift check, so it read as covered
    // (it lives in supabase/tests/, it runs in db-tests, it has a verbatim
    // block) while nothing compared it to the migration.
    fn: "capture_board_liveness_history",
    test: "supabase/tests/capture_board_liveness_history.sql",
    migration: "supabase/migrations/20260811003456_audit_20260810_board_liveness_history_decoupled_capture.sql",
  },
  {
    fn: "allday_sales_cross_source_dedup",
    test: "supabase/tests/allday_sales_cross_source_dedup.sql",
    migration: "supabase/migrations/20260702130000_audit_20260702_allday_cross_source_dedup_writer_trigger.sql",
  },
  {
    // Added 2026-08-11. 129 call sites — more than any other RPC in the repo —
    // and the write path behind pipeline_runs, which detect_stalled_pipelines(),
    // get_pipeline_alerts(), the sentinel and the daily rollup all read. Pins
    // the COALESCE-to-0 counters: a NULL reaching the column would poison every
    // downstream SUM and make a broken pipeline read as healthy-but-empty.
    fn: "log_pipeline_run",
    test: "supabase/tests/log_pipeline_run.sql",
    migration: "supabase/migrations/20260812033500_audit_20260812_snapshot_log_pipeline_run.sql",
  },
  {
    // Added 2026-08-11. Batch writer into wallet_moments_cache (~2.2M rows).
    // Pins the conditional DO UPDATE ... WHERE — without it every wallet
    // re-walk rewrites the wallet's rows, sustained HOT-update churn on a
    // disk-IO-bound instance — and the 24h clause that stops last_seen_at
    // freezing on an otherwise-unchanging moment.
    fn: "upsert_wmc_batch",
    test: "supabase/tests/upsert_wmc_batch.sql",
    migration: "supabase/migrations/20260812033600_audit_20260812_snapshot_upsert_wmc_batch.sql",
  },
  {
    // Added 2026-08-11. Bookkeeping write behind wallet_backfill_state, which
    // skip_cached reads to decide whether a wallet needs a fresh Cadence walk.
    // Pins the three distinct validation rejections (blank wallet / negative
    // count / unknown slug), the scan_count INCREMENT, and the lowercase+trim
    // normalisation that keeps writes matching reads.
    fn: "record_wallet_backfill_scan",
    test: "supabase/tests/record_wallet_backfill_scan.sql",
    migration: "supabase/migrations/20260812033700_audit_20260812_snapshot_record_wallet_backfill_scan.sql",
  },
  {
    fn: "candy_park_unresolved_sale",
    test: "supabase/tests/candy_park_unresolved_sale.sql",
    migration: "supabase/migrations/20260726233100_audit_20260726_candy_park_unresolved_sale_fn.sql",
  },
  {
    fn: "clear_badge_low_ask_missing",
    test: "supabase/tests/clear_badge_low_ask_missing.sql",
    migration: "supabase/migrations/20260427070000_badge_low_ask_clear_missing.sql",
  },
  {
    fn: "resolve_ufc_edition_by_studio_meta",
    test: "supabase/tests/resolve_ufc_edition_by_studio_meta.sql",
    migration: "supabase/migrations/20260625040127_ufc_studio_history_resolver_and_targets.sql",
  },
  {
    fn: "purge_fmv_snapshots_today",
    test: "supabase/tests/purge_fmv_snapshots_today.sql",
    migration: "supabase/migrations/20260713020000_audit_20260713_purge_fmv_snapshots_today_lock_timeout.sql",
  },
  {
    fn: "fmv_backfill_candidates",
    test: "supabase/tests/fmv_backfill_candidates.sql",
    migration: "supabase/migrations/20260626001900_fmv_backfill_candidates_antijoin_rpc.sql",
  },
  {
    fn: "purge_old_fcl_auth_nonces",
    test: "supabase/tests/purge_old_fcl_auth_nonces.sql",
    migration: "supabase/migrations/20260517140000_backfill_pack_pull_source_rip_id_and_nonces_cleanup.sql",
  },
  {
    fn: "topshot_serial_board_candidates",
    test: "supabase/tests/topshot_serial_board_candidates.sql",
    migration: "supabase/migrations/20260726012000_audit_20260726_serial_board_candidates_pooled_edition_id.sql",
  },
  {
    fn: "upsert_pack_rips_from_api",
    test: "supabase/tests/upsert_pack_rips_from_api.sql",
    migration: "supabase/migrations/20260711140000_pack_opens_api_backfill_state_and_upsert.sql",
  },
  {
    fn: "upsert_allday_marketplace_fmv",
    test: "supabase/tests/upsert_allday_marketplace_fmv.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "populate_wmc_fmv_from_snapshots",
    test: "supabase/tests/populate_wmc_fmv_from_snapshots.sql",
    // Re-pointed 2026-08-12: the function now also denormalizes `confidence`
    // into wmc.fmv_confidence, taken from the SAME snapshot row as the value.
    migration: "supabase/migrations/20260812042019_audit_20260812_populate_wmc_fmv_carry_confidence.sql",
  },
  {
    fn: "refresh_allday_ask_fmv_from_listings",
    test: "supabase/tests/refresh_allday_ask_fmv_from_listings.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "backfill_wmc_metadata_from_editions",
    test: "supabase/tests/backfill_wmc_metadata_from_editions.sql",
    migration: "supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql",
  },
  {
    fn: "update_badge_low_ask_from_cached_listings",
    test: "supabase/tests/update_badge_low_ask_from_cached_listings.sql",
    migration: "supabase/migrations/20260427020000_badge_low_ask_aggregator.sql",
  },
  {
    fn: "update_badge_low_ask_by_external",
    test: "supabase/tests/update_badge_low_ask_by_external.sql",
    migration: "supabase/migrations/20260427020000_badge_low_ask_aggregator.sql",
  },
  {
    fn: "apply_sales_ingest_external",
    test: "supabase/tests/apply_sales_ingest_external.sql",
    migration: "supabase/migrations/20260725172000_audit_20260725_sales_ingest_park_and_resolver.sql",
  },
  {
    fn: "resolve_sales_ingest_unresolved",
    test: "supabase/tests/resolve_sales_ingest_unresolved.sql",
    migration: "supabase/migrations/20260725172000_audit_20260725_sales_ingest_park_and_resolver.sql",
  },
  {
    fn: "_norm_player",
    test: "supabase/tests/norm_player.sql",
    migration: "supabase/migrations/20260713031000_audit_20260713_resolve_challenge_slots.sql",
  },
  {
    fn: "fmv_snapshots_block_phantoms",
    test: "supabase/tests/fmv_block_phantoms.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "expire_ended_challenges",
    test: "supabase/tests/expire_ended_challenges.sql",
    migration: "supabase/migrations/20260716151708_audit_20260716_expire_ended_challenges.sql",
  },
  {
    // Re-pinned 2026-07-31: the pin named the 2026-07-02 14:45 definition while
    // production has run a different SELECTION PREDICATE since 16:54 the same
    // day (circulation-gated p90*3/p90*8 → circulation-agnostic med*3 + p90*1.5).
    // Re-pinned again 2026-08-04, this time following a RENAME: the function
    // hardcoded the Top Shot UUID in both CTEs, so it ran for one collection out
    // of five and never saw the All Day rows its own predicate selects. The
    // generalised fmv_clamp_disconnected_ask(uuid, boolean) supersedes it; no
    // threshold changed, only scope.
    fn: "fmv_clamp_disconnected_ask",
    test: "supabase/tests/fmv_clamp_disconnected_ask.sql",
    migration: "supabase/migrations/20260804010000_audit_20260804_fmv_clamp_disconnected_ask_all_collections.sql",
  },
  {
    // Re-pinned 2026-07-31: the pin ran ~2 weeks behind live (4 uncommitted
    // redefinitions), so typical_pull_ev (the weighted median the public pack-EV
    // surfaces lead with), the pool_incomplete guard, and TS's forced remaining
    // basis had no pinned invariant.
    // Re-pinned 2026-08-02: fmv_coverage_pct / edition_count counted exhausted
    // (zero-weight) pool rows, so both described a pool that can no longer be
    // pulled. Now counted over weight > 0 under the basis in use; EV-neutral.
    fn: "compute_pack_ev_per_edition_weighted",
    test: "supabase/tests/compute_pack_ev_per_edition_weighted.sql",
    migration: "supabase/migrations/20260802210000_audit_20260802_pack_ev_coverage_denominator_pullable_only.sql",
  },
  {
    fn: "fmv_from_cached_listings",
    test: "supabase/tests/fmv_from_cached_listings.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "apply_fmv_thin_sales_guard",
    test: "supabase/tests/apply_fmv_thin_sales_guard.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "rpc_guard_block_destructive",
    test: "supabase/tests/rpc_guard_block_destructive.sql",
    migration: "supabase/migrations/20260719170000_audit_20260719_commit_destructive_op_circuit_breaker.sql",
  },
  {
    fn: "resolve_moment_id",
    test: "supabase/tests/resolve_moment_id.sql",
    migration: "supabase/migrations/20260704020000_audit_20260704_resolve_moment_id_cached_listings_fallback.sql",
  },
  {
    fn: "backfill_allday_edition_jersey",
    test: "supabase/tests/backfill_allday_edition_jersey.sql",
    migration: "supabase/migrations/20260710181203_audit_20260710_backfill_allday_edition_jersey_rpc.sql",
  },
  {
    fn: "refresh_topshot_fmv_display_guard",
    test: "supabase/tests/refresh_topshot_fmv_display_guard.sql",
    migration: "supabase/migrations/20260702141000_audit_20260702_fmv_display_guard_p90_disconnected.sql",
  },
  {
    fn: "check_email_allowed",
    test: "supabase/tests/check_email_allowed.sql",
    migration: "supabase/migrations/20260720210000_audit_20260720_open_front_door_check_email_allowed.sql",
  },
  {
    fn: "flowty_collection_id_from_nft_type",
    test: "supabase/tests/flowty_collection_id_from_nft_type.sql",
    migration: "supabase/migrations/20260517220000_flowty_extractor_marketplace_offers_and_rpcs.sql",
  },
  {
    fn: "get_pinnacle_wallet_best_offer_total",
    test: "supabase/tests/get_pinnacle_wallet_best_offer_total.sql",
    migration: "supabase/migrations/20260724234035_audit_20260724_pinnacle_wallet_best_offer_total.sql",
  },
  {
    fn: "get_wallet_best_offer_total",
    test: "supabase/tests/get_wallet_best_offer_total.sql",
    migration: "supabase/migrations/20260725003941_audit_20260725_get_wallet_best_offer_total.sql",
  },
  {
    fn: "pinnacle_serial_fmv_estimate",
    test: "supabase/tests/pinnacle_serial_fmv_estimate.sql",
    migration: "supabase/migrations/20260725004336_audit_20260725_pin_pinnacle_serial_fmv_estimate.sql",
  },
  {
    fn: "panini_serial_premium_mult",
    test: "supabase/tests/panini_serial_premium_mult.sql",
    migration: "supabase/migrations/20260725010500_audit_20260725_pin_panini_serial_premium_mult.sql",
  },
  {
    fn: "check_anon_write_surface",
    test: "supabase/tests/check_anon_write_surface.sql",
    migration: "supabase/migrations/20260725010345_audit_20260725_check_anon_write_surface.sql",
  },
  {
    fn: "serial_fmv_estimate",
    test: "supabase/tests/serial_fmv_estimate.sql",
    migration: "supabase/migrations/20260726015000_audit_20260726_pooled_serial_fmv_jersey1_readpath.sql",
  },
  {
    fn: "get_edition_fmv_history",
    test: "supabase/tests/get_edition_fmv_history.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "mcp_get_fmv",
    test: "supabase/tests/mcp_get_fmv.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  {
    fn: "backfill_nft_edition_map_from_sales",
    test: "supabase/tests/backfill_nft_edition_map_from_sales.sql",
    migration: "supabase/migrations/20260727180000_audit_20260727_nem_from_sales_limit_binds_on_derivable_rows.sql",
  },
  {
    // Re-pinned 2026-07-31: the pin still pointed at the 2026-04-27 migration
    // long after 20260727170000 replaced the function, so the DB test was
    // validating a superseded definition. It now tracks the live DDL.
    fn: "promote_unmapped_sales",
    test: "supabase/tests/promote_unmapped_sales.sql",
    migration: "supabase/migrations/20260731190000_audit_20260731_promote_unmapped_sales_classify_cross_source_dedup.sql",
  },
  {
    // Installed for real (not stubbed) inside promote_unmapped_sales.sql: it is
    // the only insert-suppressing trigger on public.sales, and the drainer's
    // `merged_cross_source` outcome mirrors its predicate.
    fn: "allday_sales_cross_source_dedup",
    test: "supabase/tests/promote_unmapped_sales.sql",
    migration: "supabase/migrations/20260702130000_audit_20260702_allday_cross_source_dedup_writer_trigger.sql",
  },
  {
    fn: "backfill_null_serial_sales_from_moments",
    test: "supabase/tests/backfill_null_serial_sales_from_moments.sql",
    migration: "supabase/migrations/20260705193000_audit_20260705_recover_null_serial_sales_from_moments.sql",
  },
  {
    fn: "get_wallet_moments_with_fmv",
    test: "supabase/tests/get_wallet_moments_with_fmv.sql",
    // Re-pointed 2026-08-05: the series 0-vs-1 convention fix (Top-Shot-scoped
    // normalisation of the editions.series fallback arm) supersedes the
    // 20260726 pooled-edition_id snapshot as the newest defining migration.
    migration: "supabase/migrations/20260806033000_audit_20260806_get_wallet_moments_series_topshot_convention.sql",
  },
  {
    fn: "upsert_topshot_marketplace_fmv",
    test: "supabase/tests/upsert_topshot_marketplace_fmv.sql",
    migration: "supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql",
  },
  // ── 2026-07-29: read/write RPC snapshot pins ────────────────────────────────
  // fmv_recalc_edition_page, get_edition_badges_unified, recalc_ultimate_fmv,
  // refresh_seeded_wallet_stats, and get_team_detail had no committed migration
  // carrying their current live DDL (MCP-applied, or drifted), so their verbatim
  // DDL was captured into a documentation-snapshot migration.
  {
    fn: "fmv_recalc_edition_page",
    test: "supabase/tests/fmv_recalc_edition_page.sql",
    migration: "supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql",
  },
  {
    fn: "recalc_ultimate_fmv",
    test: "supabase/tests/recalc_ultimate_fmv.sql",
    migration: "supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql",
  },
  {
    fn: "get_edition_badges_unified",
    test: "supabase/tests/get_edition_badges_unified.sql",
    migration: "supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql",
  },
  {
    fn: "refresh_seeded_wallet_stats",
    test: "supabase/tests/refresh_seeded_wallet_stats.sql",
    migration: "supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql",
  },
  {
    fn: "get_team_detail",
    test: "supabase/tests/get_team_detail.sql",
    // Re-pinned 2026-08-01: the concurrent platform-audit changed get_team_detail
    // (unaccented-slug 404 fix) via MCP with no committed migration, so the pin
    // now points at a fresh snapshot of the live body.
    migration: "supabase/migrations/20260801231400_audit_20260801_snapshot_get_team_detail_unaccented.sql",
  },
  // These already had a committed migration carrying their current live DDL.
  {
    // Re-pinned 2026-08-22: the live body gained the D20 `underlying_set_count`
    // rollup, so this pin had read STALE on every db-pin-staleness run since
    // 2026-08-10 (13 consecutive; known-issues #24). That ONE feature was the
    // entire drift — the lateral latest-FMV read and the Pinnacle branch were
    // already pinned. The 2026-08-01 graceful-timeout behaviour (BEGIN/EXCEPTION
    // WHEN query_canceled, Sentry NEXTJS-22) is unchanged and still pinned.
    fn: "get_set_detail",
    test: "supabase/tests/get_set_detail.sql",
    migration: "supabase/migrations/20260822193500_audit_20260822_snapshot_get_set_detail_underlying_set_count.sql",
  },
  {
    fn: "get_user_top_owned_moments",
    test: "supabase/tests/get_user_top_owned_moments.sql",
    migration: "supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql",
  },
  {
    fn: "get_trophy_slab_data",
    test: "supabase/tests/get_trophy_slab_data.sql",
    migration: "supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql",
  },
  {
    fn: "get_moment_detail",
    test: "supabase/tests/get_moment_detail.sql",
    migration: "supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql",
  },
  // ── 2026-07-29 batch 2: more high-traffic read RPCs ─────────────────────────
  {
    fn: "get_player_detail",
    test: "supabase/tests/get_player_detail.sql",
    migration: "supabase/migrations/20260801220000_audit_20260801_get_player_detail_current_team_tiebreak.sql",
  },
  {
    fn: "get_wallet_collection_snapshot",
    test: "supabase/tests/get_wallet_collection_snapshot.sql",
    migration: "supabase/migrations/20260806000100_audit_20260806_snapshot_get_wallet_collection_snapshot_market_closed.sql",
  },
  {
    fn: "get_pack_detail_bundle",
    test: "supabase/tests/get_pack_detail_bundle.sql",
    // re-pointed 2026-08-09: the AllDay leg now reads the lean v_allday_pack_detail_ev
    // instead of v_allday_pack_info (identical output, without the 1.19M-cost
    // pack_ev_latest join that was 500ing every AllDay pack page under contention).
    migration: "supabase/migrations/20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql",
  },
  {
    fn: "holdings_summary",
    test: "supabase/tests/holdings_summary.sql",
    migration: "supabase/migrations/20260806000200_audit_20260806_snapshot_holdings_summary_market_closed.sql",
  },
  {
    fn: "resolve_canonical_owner",
    test: "supabase/tests/resolve_canonical_owner.sql",
    migration: "supabase/migrations/20260801160000_audit_20260801_snapshot_resolve_canonical_owner.sql",
  },
  {
    fn: "resolve_canonical_player",
    test: "supabase/tests/resolve_canonical_player.sql",
    migration: "supabase/migrations/20260802181000_audit_20260802_snapshot_resolve_canonical_player.sql",
  },
  {
    fn: "upsert_player_canonical",
    test: "supabase/tests/upsert_player_canonical.sql",
    migration: "supabase/migrations/20260802181500_audit_20260802_snapshot_upsert_player_canonical.sql",
  },
  {
    fn: "update_sale_serial",
    test: "supabase/tests/update_sale_serial.sql",
    migration: "supabase/migrations/20260802182000_audit_20260802_snapshot_serial_write_guards.sql",
  },
  {
    fn: "update_topshot_sale_serial",
    test: "supabase/tests/update_topshot_sale_serial.sql",
    migration: "supabase/migrations/20260802182000_audit_20260802_snapshot_serial_write_guards.sql",
  },
  {
    fn: "record_serial_backfill_failure",
    test: "supabase/tests/record_serial_backfill_failure.sql",
    migration: "supabase/migrations/20260802182500_audit_20260802_snapshot_record_serial_backfill_failure.sql",
  },
  {
    fn: "draw_raffle",
    test: "supabase/tests/draw_raffle.sql",
    migration: "supabase/migrations/20260802183000_audit_20260802_snapshot_draw_raffle.sql",
  },
  {
    fn: "admin_verify_wallet",
    test: "supabase/tests/admin_verify_wallet.sql",
    migration: "supabase/migrations/20260802183500_audit_20260802_snapshot_admin_verify_wallet.sql",
  },
  {
    fn: "bump_concierge_ip_rate",
    test: "supabase/tests/bump_concierge_ip_rate.sql",
    migration: "supabase/migrations/20260802184000_audit_20260802_snapshot_bump_concierge_ip_rate.sql",
  },
  {
    fn: "close_expired_cached_listings",
    test: "supabase/tests/close_expired_cached_listings.sql",
    migration: "supabase/migrations/20260802184500_audit_20260802_snapshot_close_expired_cached_listings.sql",
  },
  {
    fn: "pinnacle_upsert_nft_map",
    test: "supabase/tests/pinnacle_upsert_nft_map.sql",
    migration: "supabase/migrations/20260802185000_audit_20260802_snapshot_pinnacle_upsert_nft_map.sql",
  },
  {
    fn: "mark_signal_wallets_fully_enriched",
    test: "supabase/tests/mark_signal_wallets_fully_enriched.sql",
    migration: "supabase/migrations/20260802185500_audit_20260802_snapshot_mark_signal_wallets_fully_enriched.sql",
  },
  {
    fn: "claim_pipeline_lock",
    test: "supabase/tests/claim_pipeline_lock.sql",
    migration: "supabase/migrations/20260802190000_audit_20260802_snapshot_claim_pipeline_lock.sql",
  },
  {
    fn: "check_feature_quota",
    test: "supabase/tests/check_feature_quota.sql",
    migration: "supabase/migrations/20260802190500_audit_20260802_snapshot_check_feature_quota.sql",
  },
  {
    fn: "apply_topshot_supply",
    test: "supabase/tests/apply_topshot_supply.sql",
    migration: "supabase/migrations/20260802191000_audit_20260802_snapshot_apply_topshot_supply.sql",
  },
  {
    fn: "resolve_golazos_listing_edition_ids",
    test: "supabase/tests/resolve_golazos_listing_edition_ids.sql",
    migration: "supabase/migrations/20260802191500_audit_20260802_snapshot_resolve_golazos_listing_edition_ids.sql",
  },
  {
    fn: "check_set_completion",
    test: "supabase/tests/check_set_completion.sql",
    migration: "supabase/migrations/20260802192000_audit_20260802_snapshot_check_set_completion.sql",
  },
  {
    fn: "stub_editions_from_wmc",
    test: "supabase/tests/stub_editions_from_wmc.sql",
    migration: "supabase/migrations/20260802192500_audit_20260802_snapshot_stub_editions_from_wmc.sql",
  },
  {
    fn: "detect_floor_drops",
    test: "supabase/tests/detect_floor_drops.sql",
    migration: "supabase/migrations/20260802200000_audit_20260802_snapshot_detect_floor_drops.sql",
  },
  {
    // The PREVIEW half of the deal-alert pipeline. Pinned 2026-08-17 — it was
    // the largest unpinned function on the alert path, and an alert's output is
    // SILENCE, so a defect there is unfalsifiable from the outside: the
    // 2026-08-16 migration exists because a saved, "live"-looking $0.60 alert
    // was structurally incapable of firing for weeks.
    fn: "build_deal_alerts_for_subscription",
    test: "supabase/tests/build_deal_alerts_for_subscription.sql",
    migration: "supabase/migrations/20260816161500_audit_20260816_price_only_alerts.sql",
  },
  {
    // The SENDING half of the same pipeline, pinned 2026-08-17. Its preview
    // sibling above pins what a subscriber WOULD get; this pins what is actually
    // written — pool gating, per-subscription pool exclusivity, dedupe, and the
    // rule that `enqueued` counts writes rather than matches.
    fn: "dispatch_due_deal_alerts",
    test: "supabase/tests/dispatch_due_deal_alerts.sql",
    migration: "supabase/migrations/20260816161500_audit_20260816_price_only_alerts.sql",
  },
  {
    fn: "detect_concentration_buys",
    test: "supabase/tests/detect_concentration_buys.sql",
    migration: "supabase/migrations/20260802200500_audit_20260802_snapshot_detect_concentration_buys.sql",
  },
  {
    fn: "detect_unusual_edition_volume",
    test: "supabase/tests/detect_unusual_edition_volume.sql",
    migration: "supabase/migrations/20260802201000_audit_20260802_snapshot_detect_unusual_edition_volume.sql",
  },
  {
    fn: "detect_new_edition_early_buyers",
    test: "supabase/tests/detect_new_edition_early_buyers.sql",
    migration: "supabase/migrations/20260802201500_audit_20260802_snapshot_detect_new_edition_early_buyers.sql",
  },
  {
    fn: "detect_topshot_sweeps",
    test: "supabase/tests/detect_topshot_sweeps.sql",
    migration: "supabase/migrations/20260802202000_audit_20260802_snapshot_detect_topshot_sweeps.sql",
  },
  {
    fn: "compute_pinnacle_serial_fmv_multipliers",
    test: "supabase/tests/compute_pinnacle_serial_fmv_multipliers.sql",
    migration: "supabase/migrations/20260802203000_audit_20260802_snapshot_compute_pinnacle_serial_fmv_multipliers.sql",
  },
  {
    fn: "roll_pack_ask_hourly_low",
    test: "supabase/tests/roll_pack_ask_hourly_low.sql",
    migration: "supabase/migrations/20260802204000_audit_20260802_snapshot_roll_pack_ask_hourly_low.sql",
  },
  {
    fn: "remap_topshot_parallel_to_base_misattributed",
    test: "supabase/tests/remap_topshot_parallel_to_base_misattributed.sql",
    migration: "supabase/migrations/20260802204500_audit_20260802_snapshot_remap_topshot_parallel_to_base_misattributed.sql",
  },
  {
    fn: "remap_topshot_base_keyed_parallel_sales",
    test: "supabase/tests/remap_topshot_base_keyed_parallel_sales.sql",
    migration: "supabase/migrations/20260802205000_audit_20260802_snapshot_remap_topshot_base_keyed_parallel_sales.sql",
  },
  // ── Added 2026-08-15 (test-coverage pass) ─────────────────────────────────
  // The TopShot remap/conflation family was 2-of-9 pinned. Every member mutates
  // the sales/wmc/editions keying that all edition-keyed FMV derives from, so
  // pinning two of them and leaving seven was an arbitrary line — the two that
  // were pinned are simply the two someone happened to write a snapshot for.
  // These close the family. Each was validated on a local postgres:16 and
  // mutation-proven (every assertion demonstrably reddens on a one-token change).
  {
    // The only member that DELETES. Pins the int-key gate (refuses to remap onto
    // a UUID-keyed target, keeping the two key conventions apart), the
    // slot-scoped collision split between UPDATE and DELETE, and the
    // `edition_id <> v_canon` guard that stops a half-migrated row satisfying
    // its own EXISTS subquery and deleting itself.
    fn: "remap_pack_pool_uuid_key",
    test: "supabase/tests/remap_pack_pool_uuid_key.sql",
    migration: "supabase/migrations/20260815160000_audit_20260815_snapshot_remap_pack_pool_uuid_key.sql",
  },
  {
    // Widest blast radius in the family — rewrites edition_id AND serial_number
    // on `sales`. Pins the slice rotation (a sale in the gap between the fresh
    // window and the current slice is legitimately skipped), the ambiguity guard
    // that drops moments whose wmc rows disagree rather than guessing (without it
    // they are re-keyed on every run, oscillating forever without ever erroring),
    // and the dup_pairs serial-collision guard.
    fn: "remap_misattributed_topshot_sales",
    test: "supabase/tests/remap_misattributed_topshot_sales.sql",
    migration: "supabase/migrations/20260815161000_audit_20260815_snapshot_remap_misattributed_topshot_sales.sql",
  },
  {
    // Re-keys FOSSIL wmc rows (edition_key not in canonical setID:playID[::subID]
    // form). wmc is the portfolio store and its UUID fossils render as real
    // moments on /share, so a bad re-key is user-visible. Pins the
    // COALESCE(parallel, base) precedence — collapsing it is the conflation
    // defect itself and is invisible in the return value — plus the fact that an
    // unresolvable row is COUNTED rather than written to a fallback, and that the
    // audit table's predicate matches the UPDATE's (it is the revert path).
    fn: "remap_topshot_wmc_from_onchain_map",
    test: "supabase/tests/remap_topshot_wmc_from_onchain_map.sql",
    migration: "supabase/migrations/20260815162000_audit_20260815_snapshot_remap_topshot_wmc_from_onchain_map.sql",
  },
  {
    // Re-keys sales AND moments from the on-chain map. Pins the deliberate
    // asymmetry: sales move unconditionally, moments move FREE-SLOT ONLY and a
    // blocked one is reported as `moments_deferred_conflict` rather than forced
    // (which would corrupt moment identity) or dropped silently (which would make
    // the return value lie).
    fn: "remap_topshot_from_onchain_map",
    test: "supabase/tests/remap_topshot_from_onchain_map.sql",
    migration: "supabase/migrations/20260815163000_audit_20260815_snapshot_remap_topshot_from_onchain_map.sql",
  },
  {
    // Splits base-keyed rows onto their resolved ::N parallel across sales, wmc
    // AND moments. Its migration was already committed and was verified
    // byte-identical to LIVE on 2026-08-15, so no snapshot was needed — only the
    // test was missing. Pins the LIMIT-binds-on-actionable clause (without it the
    // drain samples an arbitrary slice of a ~99%-already-split 673k-row table and
    // reports success while making no progress) and the knot skip holding across
    // all three tables at once.
    fn: "remap_topshot_split_resolved_subeditions",
    test: "supabase/tests/remap_topshot_split_resolved_subeditions.sql",
    migration:
      "supabase/migrations/20260729030000_audit_20260729_split_resolved_subeditions_limit_binds_on_actionable.sql",
  },
  {
    // Realigns rows already carrying a ::N suffix onto the RIGHT parallel (or
    // back to the base). Pins the `LIKE base || '::%'` confinement, which is the
    // only thing stopping a realign dragging a row across bases.
    fn: "remap_topshot_realign_miskeyed_subeditions",
    test: "supabase/tests/remap_topshot_realign_miskeyed_subeditions.sql",
    migration:
      "supabase/migrations/20260815164000_audit_20260815_snapshot_remap_topshot_realign_miskeyed_subeditions.sql",
  },
  {
    // The function the rest of the family defers TO: every other remapper detects
    // a knot and skips it, this is the only thing that unties one. Pins the
    // 2-move permutation's DISTINCT transient serial parks (+3M/+4M — parking
    // both at the same offset makes them collide with each other mid-swap, which
    // the test's real UNIQUE(edition_id, serial_number) index makes observable)
    // and the defensive re-check that refuses to apply a stale candidate.
    // Its migration was already committed and verified byte-identical to LIVE on
    // 2026-08-15, so only the test was missing.
    fn: "resolve_topshot_subedition_collision_knots",
    test: "supabase/tests/resolve_topshot_subedition_collision_knots.sql",
    migration:
      "supabase/migrations/20260705223000_audit_20260705_collision_knot_resolver_orchestrator_step.sql",
  },
  {
    fn: "classify_acquisition",
    test: "supabase/tests/classify_acquisition.sql",
    migration: "supabase/migrations/20260801160100_audit_20260801_snapshot_classify_acquisition.sql",
  },
  {
    fn: "raise_impossible_parallel_circ",
    test: "supabase/tests/raise_impossible_parallel_circ.sql",
    migration: "supabase/migrations/20260801160200_audit_20260801_snapshot_raise_impossible_parallel_circ.sql",
  },
  {
    fn: "get_wallet_total_fmv",
    test: "supabase/tests/get_wallet_total_fmv.sql",
    // re-pointed 2026-08-10: collection-scoped the editions join (fixes the
    // cross-collection FMV inflation); the fix migration supersedes the snapshot.
    migration: "supabase/migrations/20260810040000_audit_20260810_fix_get_wallet_total_fmv_collection_scope.sql",
  },
  {
    fn: "resolve_wallet_challenge_match",
    test: "supabase/tests/resolve_wallet_challenge_match.sql",
    migration: "supabase/migrations/20260801160400_audit_20260801_snapshot_resolve_wallet_challenge_match.sql",
  },
  {
    fn: "get_linked_parents",
    test: "supabase/tests/get_linked_accounts.sql",
    migration: "supabase/migrations/20260801160500_audit_20260801_snapshot_get_linked_accounts.sql",
  },
  {
    fn: "get_linked_children",
    test: "supabase/tests/get_linked_accounts.sql",
    migration: "supabase/migrations/20260801160500_audit_20260801_snapshot_get_linked_accounts.sql",
  },
  {
    fn: "award_points",
    test: "supabase/tests/award_points.sql",
    migration: "supabase/migrations/20260801160600_audit_20260801_snapshot_award_points.sql",
  },
  {
    fn: "activate_pro_from_stripe",
    test: "supabase/tests/activate_pro_from_stripe.sql",
    migration:
      "supabase/migrations/20260801230000_audit_20260801_snapshot_activate_pro_from_stripe.sql",
  },
  {
    fn: "admin_adjust_points",
    test: "supabase/tests/admin_adjust_points.sql",
    migration:
      "supabase/migrations/20260801230100_audit_20260801_snapshot_admin_adjust_points.sql",
  },
  {
    fn: "activate_pro_from_payment",
    test: "supabase/tests/activate_pro_from_payment.sql",
    migration:
      "supabase/migrations/20260801230200_audit_20260801_snapshot_activate_pro_from_payment.sql",
  },
  {
    fn: "resolve_channel_owner",
    test: "supabase/tests/resolve_channel_owner.sql",
    migration:
      "supabase/migrations/20260801230300_audit_20260801_snapshot_resolve_channel_owner.sql",
  },
  {
    fn: "clear_badge_low_ask_stale",
    test: "supabase/tests/clear_badge_low_ask_stale.sql",
    migration:
      "supabase/migrations/20260801230400_audit_20260801_snapshot_clear_badge_low_ask_stale.sql",
  },
  {
    fn: "get_owner_channel_targets",
    test: "supabase/tests/get_owner_channel_targets.sql",
    migration:
      "supabase/migrations/20260801230500_audit_20260801_snapshot_get_owner_channel_targets.sql",
  },
  {
    fn: "fmv_apply_thin_sale_haircut",
    test: "supabase/tests/fmv_apply_thin_sale_haircut.sql",
    migration:
      "supabase/migrations/20260801230600_audit_20260801_snapshot_fmv_apply_thin_sale_haircut.sql",
  },
  {
    fn: "check_triggered_fmv_alerts",
    test: "supabase/tests/check_triggered_fmv_alerts.sql",
    migration:
      "supabase/migrations/20260801230700_audit_20260801_snapshot_check_triggered_fmv_alerts.sql",
  },
  {
    fn: "dispatch_triggered_fmv_alerts",
    test: "supabase/tests/dispatch_triggered_fmv_alerts.sql",
    migration:
      "supabase/migrations/20260801230800_audit_20260801_snapshot_dispatch_triggered_fmv_alerts.sql",
  },
  {
    fn: "get_special_serial_owners_board",
    test: "supabase/tests/get_special_serial_owners_board.sql",
    migration:
      "supabase/migrations/20260801230900_audit_20260801_snapshot_get_special_serial_owners_board.sql",
  },
  {
    fn: "get_active_challenges",
    test: "supabase/tests/get_active_challenges.sql",
    migration:
      "supabase/migrations/20260822204500_audit_20260822_snapshot_get_active_challenges_sargable_wallet_join.sql",
  },
  {
    fn: "get_challenge_plan",
    test: "supabase/tests/get_challenge_plan.sql",
    migration:
      "supabase/migrations/20260822205500_audit_20260822_snapshot_get_challenge_plan_sargable_wallet_join.sql",
  },
  {
    fn: "refresh_challenge_costs",
    test: "supabase/tests/refresh_challenge_costs.sql",
    migration:
      "supabase/migrations/20260801231200_audit_20260801_snapshot_refresh_challenge_costs.sql",
  },
  {
    // Points at the 2026-08-01 snapshot, NOT the 2026-07-13 migration whose
    // resolve_challenge_slots body is stale vs live (redefined via MCP after).
    fn: "resolve_challenge_slots",
    test: "supabase/tests/resolve_challenge_slots.sql",
    migration:
      "supabase/migrations/20260801231300_audit_20260801_snapshot_resolve_challenge_slots.sql",
  },
  {
    fn: "save_user_wallet",
    test: "supabase/tests/save_user_wallet.sql",
    migration: "supabase/migrations/20260801160700_audit_20260801_snapshot_save_user_wallet.sql",
  },
  {
    fn: "compute_serial_fmv_multipliers",
    test: "supabase/tests/compute_serial_fmv_multipliers.sql",
    migration:
      "supabase/migrations/20260801231500_audit_20260801_snapshot_compute_serial_fmv_multipliers.sql",
  },
  {
    fn: "compute_ultimate_non_special_fmv",
    test: "supabase/tests/compute_ultimate_non_special_fmv.sql",
    migration:
      "supabase/migrations/20260801231600_audit_20260801_snapshot_compute_ultimate_non_special_fmv.sql",
  },
  {
    fn: "compute_serial_fmv_power_model",
    test: "supabase/tests/compute_serial_fmv_power_model.sql",
    migration:
      "supabase/migrations/20260801231700_audit_20260801_snapshot_compute_serial_fmv_power_model.sql",
  },
  {
    fn: "compute_serial_fmv_jersey_model",
    test: "supabase/tests/compute_serial_fmv_jersey_model.sql",
    migration:
      "supabase/migrations/20260801231800_audit_20260801_snapshot_compute_serial_fmv_jersey_model.sql",
  },
  {
    fn: "grant_pro_grandfather",
    test: "supabase/tests/grant_pro_grandfather.sql",
    migration:
      "supabase/migrations/20260801231900_audit_20260801_snapshot_grant_pro_grandfather.sql",
  },
  {
    fn: "redeem_shop_item",
    test: "supabase/tests/redeem_shop_item.sql",
    migration:
      "supabase/migrations/20260802000100_audit_20260802_snapshot_redeem_shop_item.sql",
  },
  {
    fn: "record_link_state",
    test: "supabase/tests/record_link_state.sql",
    migration:
      "supabase/migrations/20260802000200_audit_20260802_snapshot_record_link_state.sql",
  },
  {
    fn: "fulfill_redemption",
    test: "supabase/tests/fulfill_redemption.sql",
    migration:
      "supabase/migrations/20260802000300_audit_20260802_snapshot_fulfill_redemption.sql",
  },
  {
    fn: "upsert_wallet_moments",
    test: "supabase/tests/upsert_wallet_moments.sql",
    migration:
      "supabase/migrations/20260802000400_audit_20260802_snapshot_upsert_wallet_moments.sql",
  },
  {
    fn: "save_fast_break_lineup",
    test: "supabase/tests/save_fast_break_lineup.sql",
    migration:
      "supabase/migrations/20260802000500_audit_20260802_snapshot_save_fast_break_lineup.sql",
  },
  {
    fn: "ensure_topshot_edition_stub",
    test: "supabase/tests/ensure_topshot_edition_stub.sql",
    migration:
      "supabase/migrations/20260802000600_audit_20260802_snapshot_ensure_topshot_edition_stub.sql",
  },
  {
    fn: "fmv_snapshots_cap_closed_market_confidence",
    test: "supabase/tests/fmv_snapshots_cap_closed_market_confidence.sql",
    migration:
      "supabase/migrations/20260804050100_audit_20260804_fmv_cap_confidence_closed_market.sql",
  },
  {
    fn: "fmv_snapshots_zero_stale_sales_count",
    test: "supabase/tests/fmv_snapshots_zero_stale_sales_count.sql",
    migration:
      "supabase/migrations/20260804060000_audit_20260804_fmv_zero_stale_sales_count.sql",
  },
  {
    fn: "fmv_snapshots_block_stale_ingest_algo",
    test: "supabase/tests/fmv_snapshots_block_stale_ingest_algo.sql",
    migration:
      "supabase/migrations/20260804210000_audit_20260804_snapshot_fmv_snapshots_remaining_write_guards.sql",
  },
  {
    fn: "tg_fmv_snapshots_set_collection",
    test: "supabase/tests/tg_fmv_snapshots_set_collection.sql",
    migration:
      "supabase/migrations/20260804210000_audit_20260804_snapshot_fmv_snapshots_remaining_write_guards.sql",
  },
  {
    fn: "stamp_unmapped_onchain_attempt",
    test: "supabase/tests/stamp_unmapped_onchain_attempt.sql",
    migration:
      "supabase/migrations/20260804220000_audit_20260804_unmapped_sales_onchain_attempts_counter.sql",
  },
  // ── Added 2026-08-15: the SCHEDULED DELETERS ───────────────────────────────
  // Measured on the live instance that day: 183 SECDEF functions in `public`
  // WRITE (insert/update/delete), 66 were pinned, 117 were not — and 25 of the
  // unpinned ones run on an ACTIVE pg_cron schedule. These three are the
  // deleters in that set, chosen first because a delete is the failure mode
  // this layer cannot recover from: over-deletion produces an ABSENCE, not an
  // error, so nothing downstream reports it.
  {
    // pg_cron `41 */6 * * *`. Deletes from pipeline_runs — the only record that
    // a run happened. A row pruned early is indistinguishable from "the
    // pipeline never ran", which CLAUDE.md records two sessions independently
    // mis-reading. Pins the retention BOUNDARY in both directions (the fixture
    // sits exactly ON the cutoff, because a boundary test that is merely NEAR
    // the boundary passes under both `<` and `<=`), and that a NULL started_at
    // is never age-pruned.
    fn: "prune_pipeline_runs",
    test: "supabase/tests/prune_pipeline_runs.sql",
    migration:
      "supabase/migrations/20260815203500_audit_20260815_snapshot_prune_pipeline_runs.sql",
  },
  {
  // ── Trust-board precompute legs (8) ───────────────────────────────────────
  //
  // ⚠ THESE ENTERED THE "SCHEDULED WRITER" POPULATION WITH NO CODE CHANGE AT ALL.
  // CLAUDE.md recorded that surface CLOSED at 52/52 on 2026-08-16. Re-derived the same
  // day with the same predicate it was 52 of 63, and eight of the eleven newcomers are
  // these legs: the 8-way cron split retired the monolithic orchestrator (jobid 287) and
  // created per-leg jobs 324-331, so each leg's NAME now appears directly in
  // cron.job.command where previously only the orchestrator's did.
  //
  // The lesson is worth more than the pins: a closed-set claim over "scheduled X" can be
  // REOPENED BY A PURE SCHEDULING CHANGE. The pin count never fell; the population grew.
  // Re-derive it, do not quote it.
  //
  // Stakes: these ten-odd metrics ARE the trust board, and v_rpc_trust_health has no
  // per-metric age column — so a leg that writes a WRONG value is indistinguishable from
  // one that wrote a right one. The max-age arm cannot see a value that is fresh and wrong.
  //
  // Every leg test also pins the same documented defect in both directions: the 999
  // sentinel fires on an ordinary error and CANNOT fire on a statement timeout, because
  // PostgreSQL excludes QUERY_CANCELED from `WHEN OTHERS`. That is current behaviour and
  // deliberately unfixed (the fix was shipped and reverted on 2026-08-15, `255e7d24`).
  //
  // Writes the ten per-collection FMV coverage arms. ⚠ Its two COALESCE(...,0) defaults
  // point in OPPOSITE directions for the identical absence: 0% stale reads as PERFECT,
  // 0% high/med share reads as WORST. Pinned, not endorsed.
    fn: "rpc_thp_leg_fmv_coverage",
    test: "supabase/tests/rpc_thp_leg_fmv_coverage.sql",
    migration:
      "supabase/migrations/20260810225549_audit_20260810_precompute_split_m1_leg_functions.sql",
  },
  {
  // Parallel-only, known-circulation-only. Both filters asserted in both directions:
  // without the second, a catalog gap (circulation 0) would read as mass conflation.
    fn: "rpc_thp_leg_impossible_parallel",
    test: "supabase/tests/rpc_thp_leg_impossible_parallel.sql",
    migration:
      "supabase/migrations/20260810230704_audit_20260810_precompute_split_m3a_widen_impossible_parallel_budget.sql",
  },
  {
  // ⚠ Two deliberate blind spots pinned because they look like health: a collection under
  // the 200-sample floor is INVISIBLE rather than safe, and with nothing over the floor the
  // arm publishes 0 — a platform-wide ingest stop reads as perfect serial supply.
    fn: "rpc_thp_leg_serial_supply",
    test: "supabase/tests/rpc_thp_leg_serial_supply.sql",
    migration:
      "supabase/migrations/20260810225549_audit_20260810_precompute_split_m1_leg_functions.sql",
  },
  {
  // The one leg whose sentinel is reachable WITHOUT an exception (empty history ->
  // NULLIF -> COALESCE 999). ⚠ It can also go NEGATIVE when more packs are published than
  // priced, which reads as very healthy against an upper-bound threshold.
    fn: "rpc_thp_leg_pack_ev",
    test: "supabase/tests/rpc_thp_leg_pack_ev.sql",
    migration:
      "supabase/migrations/20260810225549_audit_20260810_precompute_split_m1_leg_functions.sql",
  },
  {
  // ⚠ THE MODEL FOR THE OTHERS: an incomplete sweep publishes 999 (INCONCLUSIVE), never
  // the partial numbers it did collect. Compare rpc_thp_leg_fmv_coverage, which publishes a
  // hard 0 for its own absence and so reads as perfect.
    fn: "rpc_thp_leg_board_liveness",
    test: "supabase/tests/rpc_thp_leg_board_liveness.sql",
    migration:
      "supabase/migrations/20260810225549_audit_20260810_precompute_split_m1_leg_functions.sql",
  },
  {
  // Dry days is a CURRENT-STREAK counter (running bool_or from the newest day backwards),
  // not a total — which is why +1/day on the breached arm is the outage continuing rather
  // than new information, and why one captured day resets it to 0 immediately.
  // Re-pinned 2026-08-18: the streak counted on raw_supplied_sale_price, i.e.
  // raw->>'brought_at_price' — an upstream field ABANDONED and replaced 2026-08-08. It read 0 on
  // every one of the last 30 days, so the arm could only climb (+1/day, at 20 when fixed) and could
  // never clear. Re-pointed to column_last_sale_usd, live at a steady 22-24% since 08-09; the arm
  // reset to 0 on the next leg run. The fixture below now keeps the DEAD column all-zero and carries
  // the signal in the live one, so a revert yields dry_days=5 and FAILS rather than passing quietly.
  // NOTE mapping_shortfall is still built on the dead field and publishes negatives - untouched on
  // purpose, because fixing it is a semantic decision, not a re-point.
    fn: "rpc_thp_leg_panini",
    test: "supabase/tests/rpc_thp_leg_panini.sql",
    migration:
      "supabase/migrations/20260818052724_audit_20260818_repoint_panini_dry_days_arm_to_live_last_sale_usd.sql",
  },
  {
  // Thin by design; pinned for the one thing it cannot express — an empty view and a view
  // that stopped being populated both publish 0.
    fn: "rpc_thp_leg_fmv_sanity",
    test: "supabase/tests/rpc_thp_leg_fmv_sanity.sql",
    migration:
      "supabase/migrations/20260810225549_audit_20260810_precompute_split_m1_leg_functions.sql",
  },
  {
  // Reads pinnacle_fmv_history, which is a TRIGGER-written copy of pinnacle_catalog rather
  // than an independent source — so this arm's denominator is not the catalogue.
    fn: "rpc_thp_leg_pinnacle_fmv_share",
    test: "supabase/tests/rpc_thp_leg_pinnacle_fmv_share.sql",
    migration:
      "supabase/migrations/20260811012334_audit_20260811_precompute_leg_pinnacle_fmv_share_d34.sql",
  },
  {
  // ── Non-SECDEF scheduled writers (3) ──────────────────────────────────────
  //
  // ⚠ The other three of the eleven. They were missed because the sweep that produced the
  // "52 of 52" claim was scoped to SECURITY DEFINER functions, and these are not. A
  // predicate's scope is the first thing to question when a closed set turns out not to be.
  //
  // The Pinnacle FMV writer — a PRICING writer. Pins that an ASK-derived price never
  // overwrites a sales-derived one, that an absurd floor is rejected BEFORE it can reach the
  // price chart, and that a vanished floor reverts to NO_DATA rather than leaving a stale
  // ask standing as a current price.
    fn: "pinnacle_fmv_recalc_render_all",
    test: "supabase/tests/pinnacle_fmv_recalc_render_all.sql",
    migration:
      "supabase/migrations/20260623161114_pinnacle_ask_only_cover_null_confidence.sql",
  },
  {
  // Shares a file with the writer above, because the defect lives in their INTERACTION:
  // NOW() is transaction-stable, so both of that function's passes stamp one fmv_computed_at
  // and collide on this trigger's (render_id, computed_at) key. While that resolved to DO
  // NOTHING it discarded the PUBLISHED revision for 776 renders. Measured live 2026-08-16
  // after the DO UPDATE fix: 0 renders differ. ⚠ CLAUDE.md still describes this as open in
  // two places; the test asserts the fixed behaviour so a revert reds.
    fn: "pinnacle_catalog_fmv_history_capture",
    test: "supabase/tests/pinnacle_fmv_recalc_render_all.sql",
    migration:
      "supabase/migrations/20260815172945_audit_20260815_pinnacle_fmv_history_keep_last_write_per_timestamp.sql",
  },
  {
  // ⚠ Was UNPINNABLE: its only committed migration declared a zero-argument FUNCTION while
  // live is a three-argument PROCEDURE with a soft deadline and per-wallet COMMITs — drift
  // that `db:pins:check` was structurally blind to, because it only reads functions already
  // in this array. The snapshot migration above captures the live body.
  // ⚠ Its test cannot use the suite's BEGIN/ROLLBACK isolation (a COMMIT inside an explicit
  // transaction raises 2D000); it runs in a throwaway DATABASE instead. See the file header.
    fn: "reconcile_all_saved_wallet_stats",
    test: "supabase/tests/reconcile_all_saved_wallet_stats.sql",
    migration:
      "supabase/migrations/20260816181600_audit_20260816_snapshot_reconcile_all_saved_wallet_stats.sql",
  },
  {
    // pg_cron `10 9 * * *` (jobid 201). Holds a deliberate opt-in past the
    // destructive-op circuit breaker, so this pin is the ONLY remaining check
    // on what it deletes from wallet_moments_cache. Pins that the SURVIVOR is
    // the newest row per moment_id — inverting the ORDER BY keeps the ghost and
    // deletes the live owner, with an identical row count either way — and that
    // the collection scope holds (moment_id is not unique across collections).
    fn: "purge_candy_wmc_ghost_rows",
    test: "supabase/tests/purge_candy_wmc_ghost_rows.sql",
    migration:
      "supabase/migrations/20260815203600_audit_20260815_snapshot_purge_candy_wmc_ghost_rows.sql",
  },
  {
    // pg_cron `20 10 * * 0`. A WEEKLY delete against the ~2.2M-row portfolio
    // store. The 14-day bound appears TWICE and the copy inside the per-wallet
    // DELETE is load-bearing: without it, a wallet that qualifies on one stale
    // row loses its ENTIRE cache including moments seen minutes ago. Also pins
    // the seeded exemption in BOTH directions (active exempt, inactive not).
    fn: "prune_stale_wmc",
    test: "supabase/tests/prune_stale_wmc.sql",
    migration:
      "supabase/migrations/20260815203700_audit_20260815_snapshot_prune_stale_wmc.sql",
  },
  // ── Added 2026-08-15: scheduled writers that already had a matching
  // committed migration, so they needed only a test. Worth checking for before
  // authoring a snapshot — all four were verified byte-identical to live prosrc
  // and cost nothing but the test file.
  {
    // pg_cron `11 */6 * * *`. Writes pipeline_runs_daily, the INDEFINITE archive
    // and the only place pipeline history older than ~73h exists. The MONOTONE
    // GUARD (`WHERE EXCLUDED.runs >= d.runs`) is the invariant: the oldest day in
    // the re-aggregation window is being concurrently half-deleted by the pruner,
    // so without it a pass overwrites a complete day with a truncated count — a
    // plausible smaller number that nothing downstream flags.
    fn: "rollup_pipeline_runs",
    test: "supabase/tests/rollup_pipeline_runs.sql",
    migration:
      "supabase/migrations/20260806034500_audit_20260806_rollup_pipeline_runs_shape_defensive_extra.sql",
  },
  {
    // pg_cron `7-57/10 * * * *` (jobid 303), and the platform's #2 disk reader
    // (112 GB). Propagates fmv_snapshots into wmc.fmv_usd, the column ~34 DB
    // functions sum for a collector's portfolio total. Pins the latest-snapshot
    // selection, the (collection_id, edition_key) join — external_id is NOT
    // unique across collections — and the IS DISTINCT FROM churn guard, which is
    // an IO-budget property on a disk-throttled instance rather than a
    // micro-optimisation.
    fn: "refresh_wmc_fmv_changed",
    test: "supabase/tests/refresh_wmc_fmv_changed.sql",
    migration:
      "supabase/migrations/20260813143704_audit_20260813_wmc_changed_chunk_is_not_budget_scaled.sql",
  },
  {
    // pg_cron `28 */6 * * *`. An INSTRUMENT — it feeds the
    // `public_board_slow_count` trust arm, which is breached and being acted on.
    // Pins the SLOW-vs-EMPTY split: a 57014 means the board renders too slowly
    // (a perf signal), any other error means it renders BLANK (a correctness
    // signal), and the operator's next action differs completely.
    fn: "public_board_liveness_sweep",
    test: "supabase/tests/public_board_liveness_sweep.sql",
    migration:
      "supabase/migrations/20260822203000_audit_20260822_snapshot_public_board_liveness_sweep_predictive_skip.sql",
  },
  {
    // pg_cron `29 * * * *`. Feeds `unmapped_resolution_backlog_max`, also
    // breached. Pins `open_gross_unsplittable_rows` (rows in a multi-NFT tx
    // cannot be priced per-NFT, so they are permanently undrainable — which is
    // precisely the "exclude on a REASON" the arm's own text asks for), and that
    // `days_to_drain` stays NULL unless the backlog is genuinely draining rather
    // than publishing a negative ETA.
    fn: "refresh_unmapped_backlog_growth",
    test: "supabase/tests/refresh_unmapped_backlog_growth.sql",
    migration:
      "supabase/migrations/20260810030734_audit_20260809_unmapped_backlog_growth_precompute_cache.sql",
  },
  {
    // pg_cron `25 9 * * *`. One of only TWO scheduled SECDEF functions that
    // DELETE and were unpinned as of 2026-08-15 (measured: 169 SECDEF writers in
    // public, 36 on an active schedule, 17 of those unpinned). Deleters were
    // pinned first because over-deletion produces an ABSENCE, not an error, so
    // nothing downstream reports it — and this one rebuilds the cache behind the
    // thin-sale ask DISCLOSURE, the copy that tells a collector an FMV came from
    // an ask rather than from sales. A silently-empty cache does not break a
    // page; it removes a caveat from a price.
    //
    // Pins the delete-then-insert-in-one-transaction property (a reader must
    // never observe the table empty), that it rebuilds FROM THE VIEW rather than
    // from a re-derived predicate (else the disclosure drifts from the clamp it
    // describes — how the Pinnacle FMV drift guard went tautological), and that
    // a zero-row rebuild is REPORTED rather than silent.
    fn: "fmv_thin_sale_ask_disclosure_refresh",
    test: "supabase/tests/fmv_thin_sale_ask_disclosure_refresh.sql",
    migration:
      "supabase/migrations/20260805125830_audit_20260805_thin_sale_disclosure_refresh_cron_heavy_and_timeout.sql",
  },
  {
    // pg_cron `23 */6 * * *` (jobid 62, via rpc-remap-misattributed-sales) AND
    // step 5 of /api/cron/drain-conflated-subeditions. The second of the two
    // unpinned scheduled deleters, and the higher-stakes one:
    // `topshot_deals_vs_fmv` EXCLUDES the editions this table holds, so an
    // under-populated rebuild publishes CONFLATED editions on the PUBLIC deals
    // board as genuine deals, priced off a serial that belongs to two different
    // moments. It fails in the direction of showing MORE rows.
    //
    // ⚠ Its migration is a SNAPSHOT — the function was MCP-applied with no
    // committed file, which is what made it unpinnable. The file was pulled from
    // live via pg_get_functiondef (md5 511458579340501cbb8f7e608f4877f1) and is
    // a no-op to apply.
    //
    // ⚠ The two callers matter: deep-audit R7 reasoned from the dead drain route
    // alone that this guard must be ~15 days stale; measured live it is 0.0 days
    // stale over 931 rows, because jobid 62 calls it independently.
    fn: "refresh_topshot_conflated_editions_detector_only",
    test: "supabase/tests/refresh_topshot_conflated_editions_detector_only.sql",
    migration:
      "supabase/migrations/20260815180000_audit_20260815_snapshot_refresh_topshot_conflated_editions_detector_only.sql",
  },
  {
    // pg_cron `17 */6 * * *`. Writes moment_acquisitions — the COST BASIS table
    // every P&L figure a Pinnacle collector sees is computed against. A defect
    // does not throw; it shows a collector the wrong profit on their own
    // collection.
    //
    // ⚠ Pins that only PRICED sales qualify (`sale_price_usd > 0`), because a
    // basis of 0 renders as a 100%-profit moment. And pins that this path has NO
    // nft_id-scoped gate, deliberately: a moment changes hands, so each owner
    // needs their own basis. Adding the mint sibling's NOT EXISTS here — which
    // would look like making the pair consistent — would leave every buyer after
    // the first with no cost basis at all.
    fn: "backfill_pinnacle_acquisitions",
    test: "supabase/tests/backfill_pinnacle_acquisitions.sql",
    migration:
      "supabase/migrations/20260816003000_audit_20260816_snapshot_pinnacle_acquisition_backfills.sql",
  },
  {
    // pg_cron `19 * * * *`. The mint half of the same cost-basis pair.
    //
    // ⚠ Pins the two properties most likely to be "tidied" into bugs: a mint
    // writes NO buy_price (the column is absent from the INSERT list, so it lands
    // NULL — a 0 would render as 100% profit forever), and the NOT EXISTS gate is
    // scoped on nft_id ALONE rather than the table's (nft_id, wallet,
    // transaction_hash) conflict key, so a mint can never be inserted
    // retroactively beneath a later marketplace purchase by a different wallet.
    fn: "backfill_pinnacle_mint_acquisitions",
    test: "supabase/tests/backfill_pinnacle_mint_acquisitions.sql",
    migration:
      "supabase/migrations/20260816003000_audit_20260816_snapshot_pinnacle_acquisition_backfills.sql",
  },
  {
    // pg_cron `30 8 * * *`. An FMV HONESTY instrument: the set of Top Shot
    // editions whose published FMV is inflated relative to what the market
    // actually paid — THIN (<15 sales/90d) AND FMV >1.5x the 90-day median. Those
    // two constants ARE the definition, so both are pinned ON their boundaries
    // (15 sales is not thin; exactly 1.5x is not flagged).
    //
    // ⚠ It TRUNCATEs and rebuilds, which is why it needs a pin more than most: a
    // rebuild that inserts nothing leaves the table EMPTY, and empty reads
    // exactly like "no edition has an unsupported FMV" — the most reassuring
    // possible answer, produced by a broken instrument.
    fn: "refresh_topshot_thin_fmv_editions",
    test: "supabase/tests/refresh_topshot_thin_fmv_editions.sql",
    migration:
      "supabase/migrations/20260816010000_audit_20260816_snapshot_thin_fmv_and_edition_offers_backstop.sql",
  },
  {
    // pg_cron `34 * * * *`. Backstop for the offers indexer, feeding
    // edition_offers.highest_offer — the denormalized column the best-offer
    // displays read.
    //
    // ⚠ RAISE-ONLY. A backstop runs on a partial view of the chain, so lowering
    // a value the primary writer set would DELETE a real offer from every
    // surface showing it.
    //
    // ⚠ TWO mechanisms LOOK like they enforce that; only the
    // `WHERE EXCLUDED.highest_offer > COALESCE(existing, 0)` guard actually
    // does. The `GREATEST(...)` in the SET is redundant while that guard exists
    // (the guard only admits rows where EXCLUDED > existing, for which GREATEST
    // is EXCLUDED by definition) — replacing it with a plain assignment changes
    // nothing observable and the pin stays green. Verified by mutation, which
    // is how an earlier version of this comment — claiming both were pinned
    // separately — was found to be wrong. See the test file header.
    //
    // Also pins that serial/subedition offers are EXCLUDED: those are bids on one
    // specific serial, and folding one into the edition-level best offer
    // publishes a number nobody is bidding for the edition as a whole.
    fn: "raise_edition_offers_from_chain",
    test: "supabase/tests/raise_edition_offers_from_chain.sql",
    migration:
      "supabase/migrations/20260816010000_audit_20260816_snapshot_thin_fmv_and_edition_offers_backstop.sql",
  },
  {
    // pg_cron `41 5 * * *`. Backfills pinnacle_sales.edition_id from the render
    // spine — the self-heal for the exact column behind deep-audit R4, whose
    // NULLs left the overview's top-sales panel unable to NAME 2 of its top 5.
    //
    // ⚠ Pins the HAVING clause: it bridges ONLY where a render maps to exactly
    // ONE edition. Attributing a sale to an arbitrary candidate would move that
    // edition's FMV, and a wrong price is worse than a missing name. The
    // `min(pe.id)` is a GROUP BY requirement, NOT a tie-break — reading it as
    // one is the mistake to avoid. Also pins fill-only, and that the RETURN
    // counts audit inserts rather than updates (so a re-bridge with an existing
    // audit row reports 0 while doing real work).
    fn: "bridge_pinnacle_sales_editions",
    test: "supabase/tests/bridge_pinnacle_sales_editions.sql",
    migration:
      "supabase/migrations/20260816020000_audit_20260816_snapshot_pinnacle_bridge_and_allday_badge_low_ask.sql",
  },
  {
    // pg_cron `*/30 * * * *`. Two phases on badge_editions.low_ask for All Day:
    // write the current floor ask, then CLEAR it where there no longer is one.
    //
    // ⚠ The clear phase is the half that is easy to drop and expensive to lose —
    // a stale low_ask is a price that NO LONGER EXISTS shown as current, failing
    // in the reassuring direction so nothing reports it. Also pins that a ZERO
    // ask is excluded from both phases (so it clears rather than publishing 0),
    // and IS DISTINCT FROM rather than `<>` (a NULL -> value first write would
    // be skipped entirely by `<>`).
    //
    // ⚠ Its EXCEPTION WHEN OTHERS handler cannot fire on a statement timeout —
    // PostgreSQL excludes QUERY_CANCELED from OTHERS — so a timeout leaves NO
    // pipeline_runs row at all. Recorded in the test header, deliberately not
    // changed; same class as the trust-precompute 999 sentinel.
    fn: "refresh_allday_badge_low_ask",
    test: "supabase/tests/refresh_allday_badge_low_ask.sql",
    migration:
      "supabase/migrations/20260816020000_audit_20260816_snapshot_pinnacle_bridge_and_allday_badge_low_ask.sql",
  },
  {
    // pg_cron `10,40 * * * *`. The Golazos sibling of the above — and it is NOT
    // "the AllDay one with a different UUID", which is the whole reason it gets
    // its own pin: it calls resolve_golazos_listing_edition_ids() FIRST, healing
    // edition_id on newly indexed listings BEFORE reading the floor-ask view.
    //
    // ⚠ That ordering is load-bearing. golazos_edition_floor_ask joins on
    // edition_id, so a freshly indexed listing whose edition_id is still NULL is
    // INVISIBLE to it — the ask never reaches the badge and the edition reads as
    // having no ask while a live listing sits on the marketplace, with the job
    // reporting ok. Same class as the Pinnacle NULL-edition_id gap (deep-audit
    // R4). The test asserts the ordering directly, via a deliberately observable
    // stand-in resolver.
    //
    // ⚠ Coverage context before anyone "fixes" the ~37% Golazos low_ask share:
    // the ceiling is LISTING-GATED, not a defect, and a second cron will not
    // raise it. This function is that one cron.
    fn: "refresh_golazos_badge_low_ask",
    test: "supabase/tests/refresh_golazos_badge_low_ask.sql",
    migration:
      "supabase/migrations/20260816030000_audit_20260816_snapshot_refresh_golazos_badge_low_ask.sql",
  },
  {
    // pg_cron jobid 64 `10 3 * * *`, called with 20000. INFERS which pack
    // distribution an unattributed Top Shot rip came from, by matching its
    // editions against the pools observed in rips whose distribution is KNOWN.
    //
    // ⚠ Attribution feeds pack EV, which drives a PUBLIC +EV buy signal — so a
    // rip attached to the wrong distribution moves a number collectors act on.
    // Live split 2026-08-16: rip_dist/high 36,464 vs empirical_subset/medium
    // 1,001, i.e. ~2.7% of attributions are inferences sitting beside 36k
    // observations.
    //
    // ⚠ THE PROPERTY TO PROTECT ABOVE ALL: no feedback loop. Both pool CTEs read
    // method='rip_dist' ONLY, so references are ground truth and never this
    // function's own output — widen either and each inference becomes evidence
    // for the next. The two filters MASK EACH OTHER, so the test carries two
    // purpose-built fixtures (DIST-MIX, and an inferred row on DIST-A) that make
    // each independently observable; without them both mutations passed.
    //
    // Also pins: the >= 20 support bar, >= 2 editions to be identifying, full
    // (not partial) containment, and HAVING count(*) = 1 so an ambiguous rip is
    // left unattributed rather than assigned to min(dist_id).
    fn: "attribute_topshot_rips_empirical",
    test: "supabase/tests/attribute_topshot_rips_empirical.sql",
    migration:
      "supabase/migrations/20260816040000_audit_20260816_snapshot_attribute_topshot_rips_empirical.sql",
  },
  {
    // pg_cron `25 * * * *`. Hourly pack EV for every Top Shot distribution whose
    // drop pool came from Atlas, appended to pack_ev_history — the table behind
    // pack_ev_latest and the PUBLIC **+EV** badge.
    //
    // ⚠ `is_positive_ev` is the one boolean a collector reads as "buying this
    // pack is worth it", so the pins here are honesty guards: no +EV without a
    // known ask, a NULL value_ratio rather than a fabricated one, a delisted or
    // zero ask treated as NO ask (not a $0 pack, which would look infinitely
    // +EV), and a FAILED EV computation still writing a row — skipping would
    // leave last hour's row as pack_ev_latest and keep a stale badge live.
    //
    // ⚠ Also pins that `pack_ev` and `is_positive_ev` can legitimately disagree:
    // an ask-less pack gets a positive-looking pack_ev equal to its gross EV
    // while the flag is NULL. Anything rendering a buy signal must read the FLAG.
    fn: "refresh_atlas_pack_ev",
    test: "supabase/tests/refresh_atlas_pack_ev.sql",
    migration:
      "supabase/migrations/20260816050000_audit_20260816_snapshot_refresh_atlas_pack_ev.sql",
  },
  {
    // pg_cron `13 * * * *` — one of the three heavy jobs CLAUDE.md names as
    // colliding at :13. Backfills pack EV at the PRIMARY retail price (its atlas
    // sibling prices against the secondary ask), into the same pack_ev_history
    // behind the public +EV badge.
    //
    // ⚠ THE PIN EXISTS FOR ONE CLAUSE: `gross_ev <= 3 * sec_ask`, the
    // survivor-bias cap. A DEPLETED Top Shot pool prices at 40-86x — the good
    // moments are gone and what remains is the tail — so an EV over the original
    // pool is absurd. This DISCARDS such a row. Removing it puts a green +EV
    // badge on packs that are nothing of the sort. The cheapest live ask is the
    // denominator (ORDER BY ASC), and the test pins that too: with the dearest
    // ask instead, a 40x EV sails through.
    //
    // Also pins the satoshi conversion (>= 1000000 divided by 1e8 — eight orders
    // of magnitude), weighted-pools-only, and that a SENTINEL row does not count
    // as covered so a failed distribution is retried rather than suppressed for
    // 12 hours.
    fn: "backfill_topshot_historical_pack_ev",
    test: "supabase/tests/backfill_topshot_historical_pack_ev.sql",
    migration:
      "supabase/migrations/20260816060000_audit_20260816_snapshot_backfill_topshot_historical_pack_ev.sql",
  },
  // ── The last four unpinned SCHEDULED SECDEF writers (2026-08-16) ──────────
  // With these, that whole population is pinned: it was measured at 33 scheduled
  // writers, 14 of them unpinned, on 2026-08-15.
  {
    // pg_cron `37 5 * * *`. FABRICATES a CDN thumbnail url for artless Top Shot
    // editions by borrowing a representative moment's asset path.
    //
    // ⚠ It is a synthesised URL, so the only thing between "the edition finally
    // shows its art" and "the edition shows SOMEONE ELSE'S art" is which moment
    // is picked. The three-tier COALESCE is that choice; tier (c) matches on
    // subedition_id so a parallel cannot inherit a sibling parallel's or the
    // base printing's image — the conflation class this repo keeps paying for.
    //
    // Also pins: no representative means no row (and no audit row claiming a
    // fill that never happened), fill-only in both directions, and that the
    // audit table is a ONCE-ONLY ledger — a manually undone fill is never redone.
    fn: "fill_ts_artless_from_rep_moments",
    test: "supabase/tests/fill_ts_artless_from_rep_moments.sql",
    migration:
      "supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql",
  },
  {
    // pg_cron `10 4 * * *`. Rebuilds the cross-collection cohort.
    //
    // ⚠ `HAVING COUNT(DISTINCT collection_id) >= 3` is not a tuning constant —
    // it is what "cross-collection collector" MEANS here, and every downstream
    // figure is a statement about that cohort. Pinned from both sides of the
    // boundary, plus DISTINCT-not-COUNT(*), the atomic TRUNCATE-then-rebuild,
    // and the single shared computed_at.
    //
    // ⚠ Also pins what the fmv COALESCE actually does: SUM already ignores
    // NULLs, so it only matters when EVERY moment is unpriced — and there it
    // publishes a hard $0.00 rather than NULL. Recorded as current behaviour,
    // not endorsed; it is the `?? 0` shape in a DB function.
    fn: "refresh_cross_collection_cohort_step1",
    test: "supabase/tests/refresh_cross_collection_cohort_step1.sql",
    migration:
      "supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql",
  },
  {
    // pg_cron `25 4 * * *`. The DOWNSTREAM half of the pair — per Top Shot set,
    // how much of the cohort holds it.
    //
    // ⚠ It has NO check that step1 ran. Pinned so the failure mode is a known
    // property: an empty cohort quietly yields an empty overlap table, and the
    // realistic version is "yesterday's cohort" because step1 truncates inside
    // its own transaction. Also pins holders-are-DISTINCT-wallets (COUNT(*)
    // there would inflate "how many people" by each collector's position depth)
    // and both collection scopes — the editions-side one needs a colliding
    // external_id to be observable at all, which is a real state.
    fn: "refresh_cross_collection_cohort_step2",
    test: "supabase/tests/refresh_cross_collection_cohort_step2.sql",
    migration:
      "supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql",
  },
  {
    // pg_cron `45 9 * * *`. Refreshes the five "new collectors" MVs.
    //
    // ⚠ THE ORDER IS THE INVARIANT: `mv_ts_buyer_first_buy` first, because the
    // other four derive from it. Refreshing a dependent view before its base
    // recomputes it from YESTERDAY's data — silently, with the run still ok,
    // leaving a summary that disagrees with the base it summarises. The test
    // shims REFRESH via an event trigger to observe the sequence, since view
    // contents can only show that data is right, not that it was computed in the
    // order that makes it right.
    //
    // Also pins that its EXCEPTION handler logs ok:false and does NOT re-raise,
    // so cron.job_run_details reports success and pipeline_runs.ok is the only
    // health signal.
    fn: "refresh_insights_new_collectors",
    test: "supabase/tests/refresh_insights_new_collectors.sql",
    migration:
      "supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql",
  },
  // ── The scheduled MV-refresh wrappers (2026-08-16) ───────────────────────
  // Nine near-identical one-liners sharing ONE test file. Their bodies hold no
  // logic, but two real invariants live OUTSIDE them:
  //   • CONCURRENTLY REQUIRES A UNIQUE INDEX on the view. Drop that index — in a
  //     different migration, touching a different object — and every one of
  //     these crons fails at runtime. The test proves the coupling rather than
  //     asserting it in prose.
  //   • Each wrapper must name the view its own name implies. Five share a body
  //     differing only in the view name, and a copy-paste slip is SILENT: one
  //     view refreshes twice a cycle, another never does and goes stale behind
  //     whatever reads it, with nothing erroring.
  // refresh_topshot_misattrib_candidates deliberately does NOT use CONCURRENTLY
  // (internal MV, no public read path, so the exclusive lock is free and it
  // needs no unique index) — asserted as an exception so a "harmonising"
  // tidy-up has to make that call on purpose.
  {
    fn: "refresh_sets_summary",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_mv_pack_ev_latest",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_allday_pack_realized",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_allday_pack_sales_agg",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_topshot_pack_sales_agg",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_topshot_pack_rip_values",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_topshot_edition_median",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_mv_topshot_set_play_catalog",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    fn: "refresh_topshot_misattrib_candidates",
    test: "supabase/tests/mv_refresh_wrappers.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // pg_cron `14 * * * *`. Denormalizes each All Day rip's TOTAL pull value.
    //
    // ⚠ ALL-OR-NOTHING: written only when EVERY pull is priced. A partial sum is
    // a SMALLER number that reads exactly like a real one — a 5-moment rip with
    // 2 priced pulls would publish those 2 as the pack's value, making a good
    // pull look like a bad pack, and it fails in the reassuring direction so
    // nothing reports it.
    //
    // ⚠ Its watermark is captured BEFORE the read, so a pull changed mid-run is
    // re-processed next tick rather than skipped forever; and `updated_at >= w`
    // is inclusive, because re-processing is free (change-detection) while
    // skipping is not. The inclusive half is asserted; the before-vs-after half
    // needs a concurrent writer and is documented as a harness limit.
    fn: "rollup_allday_rip_pull_value",
    test: "supabase/tests/rollup_allday_rip_pull_value.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // pg_cron `40 9 * * *`. Sets players.team from the catalogue.
    //
    // ⚠ THE 18-MONTH WINDOW IS ANCHORED TO THE CATALOGUE'S OWN MAX game_date,
    // NOT now(). That is what stops the window sliding off the end of the data
    // through an offseason, an ingest stall, or a closed market — the same class
    // as the panini gate whose denominator was a rolling window of the series it
    // watched. Pinned with every fixture date years in the past, so a
    // now()-anchored window would make the whole file inert.
    //
    // Also pins latest-appearance-wins, and that a teamless edition cannot BLANK
    // a team already known.
    fn: "refresh_players_current_team",
    test: "supabase/tests/refresh_players_current_team.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // pg_cron `24 * * * *`. Copies All Day minted/opened totals onto
    // pack_distributions, which drive the depletion figure a collector reads
    // before buying.
    //
    // ⚠ `coalesce(packnft_total,0) > 0` refuses to write a ZERO minted total:
    // that is the indexer saying "not yet", not the chain saying "none", and
    // copying it publishes a depletion percentage computed against a supply of
    // nothing. Note the guard is on MINTED only — zero OPENS is a real state and
    // must still be written, or every never-ripped pack freezes forever.
    fn: "sync_allday_pack_dist_totals",
    test: "supabase/tests/sync_allday_pack_dist_totals.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // pg_cron `2-59/5 * * * *`. Labels wmc rows with their FMV confidence.
    //
    // ⚠ VALUE AND LABEL COME FROM THE SAME SNAPSHOT ROW — one LATERAL selects
    // both. Two separate lookups, even two correct ones, would let a row carry
    // one snapshot's price under another's confidence: a STALE price wearing a
    // HIGH label is a number a collector has no way to distrust.
    //
    // ⚠ Also pins that its CROSS JOIN (not LEFT) leaves an edition with no
    // priced snapshot unlabelled forever, and that `LIMIT` bounds rows EXAMINED
    // rather than written — together those are the mechanism behind the
    // permanent backlog floor and behind this job becoming the instance's #1
    // disk reader once its queue drained.
    fn: "backfill_wmc_fmv_confidence",
    test: "supabase/tests/backfill_wmc_fmv_confidence.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // pg_cron `13 4,16 * * *`.
    //
    // ⚠ ITS NAME SAYS TOPSHOT AND IT REFRESHES **TWO** MVs — Top Shot AND All
    // Day. Someone auditing All Day's special serials for a refresh job will not
    // find one, because it lives inside a function named for another collection.
    // Pinned so the pairing cannot be silently halved: dropping the All Day line
    // leaves the Top Shot board fine and the All Day one frozen, with the run
    // still reporting ok.
    //
    // Also pins the `enable_nestloop=off` PLANNER HINT baked into the function
    // definition — invisible from every call site, and nothing would notice its
    // removal until the job started timing out at its 200s budget — and that its
    // NAMED-ARGUMENT log_pipeline_run call really resolves and lands a row, the
    // failure mode where one wrong argument name makes a pipeline vanish from
    // telemetry entirely.
    fn: "refresh_topshot_special_serial_owners_mv",
    test: "supabase/tests/refresh_topshot_special_serial_owners_mv.sql",
    migration:
      "supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql",
  },
  {
    // Added 2026-08-20, deleters-first. Over-deletion produces an ABSENCE rather
    // than an error: nothing raises, the rows are gone, and every downstream
    // reader silently agrees with the smaller number. The load-bearing clause is
    // not the age — it is `feedback_type IS NULL`, which keeps a conversation the
    // user gave feedback on FOREVER. That feedback is the only durable record of
    // what a real collector told us the product got wrong, and it cannot be
    // re-fetched from anywhere.
    fn: "purge_old_support_conversations",
    test: "supabase/tests/purge_old_support_conversations.sql",
    migration: "supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql",
  },
  {
    // Added 2026-08-20. `usage_events` backs the active-user count, and the
    // roadmap gates monetization on "50+ weekly active users". A retention bug
    // here moves the headline metric DOWN — the direction that reads as "not
    // ready yet", so nobody questions it.
    fn: "purge_old_usage_events",
    test: "supabase/tests/purge_old_usage_events.sql",
    migration: "supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql",
  },
  {
    // Added 2026-08-20. ⚠ The one whose cutoff is DATE arithmetic
    // (`CURRENT_DATE - p_days_keep`) rather than `NOW() - interval` like every
    // sibling — correct, because `snapshot_at` is a `date`. Pinned so a
    // consistency pass cannot harmonise it into an uncast timestamptz comparison
    // and move the boundary by up to 24h. Portfolio history is not re-derivable:
    // the snapshots ARE the record of what a wallet held on a past day.
    fn: "purge_old_wallet_holdings_snapshots",
    test: "supabase/tests/purge_old_wallet_holdings_snapshots.sql",
    migration: "supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql",
  },
]/**
 * Find the first `CREATE OR REPLACE FUNCTION public.<name>` occurrence that is
 * NOT inside a `--` line comment. Migrations frequently carry the prior version
 * of a function commented out (e.g. in a REVERT note), so a naive indexOf would
 * latch onto the stale commented copy and compare the wrong DDL.
 */
// ⚠ PROCEDURE, not just FUNCTION. This looked for `CREATE OR REPLACE FUNCTION` only
// until 2026-08-16, which made every PROCEDURE in this database UNPINNABLE — the
// extractor returned null and the pin could not be added at all. Postgres treats the
// two as separate object kinds and pg_proc holds both (prokind 'f' vs 'p'), so a
// scheduled writer that happens to be a procedure was outside this guard's reach BY
// CONSTRUCTION, however often it ran green. `reconcile_all_saved_wallet_stats` is one
// (it COMMITs per wallet, which is only legal in a procedure); so is the trust-board
// orchestrator `rpc_trust_health_precompute_refresh_p`.
//
// It failed SAFE rather than silently — a missing extraction reds the pin's own test —
// but "safe" here meant the pin could never be written, which is indistinguishable from
// nobody having got round to it. That is the same shape as the other scope blind spots
// in this repo: the guard's own predicate decided what it was able to see.
const FN_KINDS = ["FUNCTION", "PROCEDURE"] as const

function findFnStart(src: string, name: string): number {
  for (const kind of FN_KINDS) {
    const needle = `CREATE OR REPLACE ${kind} public.${name}`
    let from = 0
    for (;;) {
      const idx = src.indexOf(needle, from)
      if (idx < 0) break
      const lineStart = src.lastIndexOf("\n", idx) + 1
      // if the same line has a `--` before the match, it's a comment — skip it.
      if (!src.slice(lineStart, idx).includes("--")) return idx
      from = idx + needle.length
    }
  }
  return -1
}

/**
 * Extract a `CREATE OR REPLACE FUNCTION public.<name> ... $tag$ ... $tag$;` block
 * (dollar-quoted body, tag auto-detected) and normalize its whitespace.
 */
function extractSqlFn(src: string, name: string): string | null {
  const start = findFnStart(src, name)
  if (start < 0) return null
  const rest = src.slice(start)
  const tagMatch = /\$([a-zA-Z_]*)\$/.exec(rest)
  if (!tagMatch) return null
  const tag = tagMatch[0] // "$$" or "$function$"
  const bodyOpen = tagMatch.index + tag.length
  const closeRel = rest.indexOf(tag, bodyOpen)
  if (closeRel < 0) return null
  const semi = rest.indexOf(";", closeRel + tag.length)
  if (semi < 0) return null
  return rest.slice(0, semi + 1).replace(/\s+/g, " ").trim()
}

describe("the extractor itself handles both object kinds", () => {
  // Guards the guard. Without this, narrowing findFnStart back to FUNCTION-only would
  // simply make every procedure pin fail with "not found" — which reads like a bad path
  // or a renamed function, not like a lost capability.
  const FN = `CREATE OR REPLACE FUNCTION public.zz_probe()\n RETURNS void LANGUAGE plpgsql\nAS $fn$ BEGIN NULL; END $fn$;\n`
  const PROC = `CREATE OR REPLACE PROCEDURE public.zz_probe(IN a integer)\n LANGUAGE plpgsql\nAS $procedure$ BEGIN COMMIT; END $procedure$;\n`

  it("extracts a FUNCTION", () => {
    expect(extractSqlFn(FN, "zz_probe")).toContain("CREATE OR REPLACE FUNCTION public.zz_probe")
  })

  it("extracts a PROCEDURE", () => {
    expect(extractSqlFn(PROC, "zz_probe")).toContain("CREATE OR REPLACE PROCEDURE public.zz_probe")
  })

  it("still skips a commented-out declaration of either kind", () => {
    expect(extractSqlFn(`-- ${FN}`, "zz_probe")).toBeNull()
    expect(extractSqlFn(`-- ${PROC}`, "zz_probe")).toBeNull()
  })

  it("every pin file carrying a verbatim copy is REGISTERED — the list cannot silently drift", () => {
    // ⚠ PINS is a CURATED LIST, which is the shape this repo has been bitten by
    // more than any other. A pin file that embeds a verbatim copy of a live DB
    // object but is absent from PINS is the worst kind of miss: it reads as
    // covered from every angle — it sits in supabase/tests/, db-tests executes
    // it, and it visibly contains the object's DDL — while NOTHING compares that
    // DDL to the migration. Its copy can rot indefinitely.
    //
    // Measured 2026-08-20 when this arm was added: 172 files carried a verbatim
    // block and 2 were unregistered — capture_board_liveness_history (now
    // registered above) and v_pack_pipeline_health.
    //
    // ⚠ THE VIEW EXCLUSION IS ARGUED, NOT AN ALLOWLIST OF CONVENIENCE. The
    // extractor below is FN_KINDS = FUNCTION | PROCEDURE and locates a body by
    // its $tag$ delimiters; a VIEW has neither, so a view pin cannot be
    // registered under the current mechanism at all. It is excluded by what it
    // IS, re-derived from the file on every run, not by being named — so a view
    // pin that is later converted to a function stops being excluded
    // automatically. Extending the extractor to views is the real fix and is
    // deliberately not attempted here.
    const dir = path.join(root, "supabase", "tests")
    const withVerbatim = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(path.join(dir, f), "utf8").includes("BEGIN verbatim"))

    expect(withVerbatim.length, "the walk found no pin files at all").toBeGreaterThan(100)

    const registered = new Set(PINS.map((p) => p.test.replace(/^supabase\/tests\//, "")))
    const unregistered = withVerbatim.filter((f) => !registered.has(f))

    const isViewPin = (f: string) =>
      /CREATE OR REPLACE VIEW|DROP VIEW IF EXISTS/.test(readFileSync(path.join(dir, f), "utf8"))
    const viewPins = unregistered.filter(isViewPin)
    const realMisses = unregistered.filter((f) => !isViewPin(f))

    expect(
      realMisses,
      "these pin files embed a verbatim DB object but are in no drift check — register them in PINS:\n" +
        realMisses.join("\n"),
    ).toEqual([])

    // The exclusion is real, so keep it honest: if it ever empties, the special
    // case should go rather than linger as dead reasoning.
    expect(viewPins.length, "the view exclusion is now empty — delete it and the argument above").toBeGreaterThan(0)
  })

  it("at least one pin is actually a PROCEDURE, so the capability is exercised for real", () => {
    // Not vacuous, and satisfiable at any population > 0: if the last procedure pin is
    // ever removed this reds, prompting a decision rather than silent rot.
    const procPins = PINS.filter(({ test }) =>
      /CREATE OR REPLACE PROCEDURE public\./.test(readFileSync(path.join(root, test), "utf8")),
    )
    expect(procPins.length).toBeGreaterThan(0)
  })
})

describe("DB-invariant drift guard — embedded DDL must equal the committed migration", () => {
  it.each(PINS)("$fn: the SQL test's copy is byte-identical (normalized) to its migration", ({ fn, test, migration }) => {
    const testSrc = readFileSync(path.join(root, test), "utf8")
    const migSrc = readFileSync(path.join(root, migration), "utf8")

    const embedded = extractSqlFn(testSrc, fn)
    const committed = extractSqlFn(migSrc, fn)

    expect(embedded, `${fn} not found in ${test}`).not.toBeNull()
    expect(committed, `${fn} not found in ${migration}`).not.toBeNull()
    expect(embedded).toBe(committed)
  })
})
