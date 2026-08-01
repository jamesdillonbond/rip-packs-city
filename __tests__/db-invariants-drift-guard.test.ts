import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
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
    fn: "allday_sales_cross_source_dedup",
    test: "supabase/tests/allday_sales_cross_source_dedup.sql",
    migration: "supabase/migrations/20260702130000_audit_20260702_allday_cross_source_dedup_writer_trigger.sql",
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
    migration: "supabase/migrations/20260704010200_audit_20260704_wmc_fmv_populate_null_path_skip_locked.sql",
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
    fn: "fmv_clamp_disconnected_ask_topshot",
    test: "supabase/tests/fmv_clamp_disconnected_ask.sql",
    migration: "supabase/migrations/20260731210000_audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev.sql",
  },
  {
    // Re-pinned 2026-07-31: the pin ran ~2 weeks behind live (4 uncommitted
    // redefinitions), so typical_pull_ev (the weighted median the public pack-EV
    // surfaces lead with), the pool_incomplete guard, and TS's forced remaining
    // basis had no pinned invariant.
    fn: "compute_pack_ev_per_edition_weighted",
    test: "supabase/tests/compute_pack_ev_per_edition_weighted.sql",
    migration: "supabase/migrations/20260731210000_audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev.sql",
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
    migration: "supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql",
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
    migration: "supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql",
  },
  // These already had a committed migration carrying their current live DDL.
  {
    // Re-pinned 2026-08-01: get_set_detail now wraps its expensive per-edition FMV
    // rollup in BEGIN/EXCEPTION WHEN query_canceled to degrade (not throw) on a
    // request-level statement timeout (Sentry NEXTJS-22). Live DDL moved from the
    // 2026-06-26 render-level migration to the graceful-timeout migration below.
    fn: "get_set_detail",
    test: "supabase/tests/get_set_detail.sql",
    migration: "supabase/migrations/20260801190000_audit_20260801_get_set_detail_graceful_fmv_timeout.sql",
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
    migration: "supabase/migrations/20260729000100_audit_20260729_snapshot_read_rpc_ddl_batch2.sql",
  },
  {
    fn: "get_wallet_collection_snapshot",
    test: "supabase/tests/get_wallet_collection_snapshot.sql",
    migration: "supabase/migrations/20260729000100_audit_20260729_snapshot_read_rpc_ddl_batch2.sql",
  },
  {
    fn: "get_pack_detail_bundle",
    test: "supabase/tests/get_pack_detail_bundle.sql",
    migration: "supabase/migrations/20260725010200_audit_20260725_get_pack_detail_bundle_hero_fast.sql",
  },
  {
    fn: "holdings_summary",
    test: "supabase/tests/holdings_summary.sql",
    migration: "supabase/migrations/20260729000200_audit_20260729_snapshot_holdings_summary_ddl.sql",
  },
  {
    fn: "resolve_canonical_owner",
    test: "supabase/tests/resolve_canonical_owner.sql",
    migration: "supabase/migrations/20260801160000_audit_20260801_snapshot_resolve_canonical_owner.sql",
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
    migration: "supabase/migrations/20260801160300_audit_20260801_snapshot_get_wallet_total_fmv.sql",
  },
]

/**
 * Find the first `CREATE OR REPLACE FUNCTION public.<name>` occurrence that is
 * NOT inside a `--` line comment. Migrations frequently carry the prior version
 * of a function commented out (e.g. in a REVERT note), so a naive indexOf would
 * latch onto the stale commented copy and compare the wrong DDL.
 */
function findFnStart(src: string, name: string): number {
  const needle = `CREATE OR REPLACE FUNCTION public.${name}`
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx < 0) return -1
    const lineStart = src.lastIndexOf("\n", idx) + 1
    // if the same line has a `--` before the match, it's a comment — skip it.
    if (!src.slice(lineStart, idx).includes("--")) return idx
    from = idx + needle.length
  }
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
