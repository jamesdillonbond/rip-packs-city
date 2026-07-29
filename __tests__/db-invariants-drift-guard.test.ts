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
    fn: "fmv_clamp_disconnected_ask_topshot",
    test: "supabase/tests/fmv_clamp_disconnected_ask.sql",
    migration: "supabase/migrations/20260702140000_audit_20260702_fmv_clamp_disconnected_ask_topshot.sql",
  },
  {
    fn: "compute_pack_ev_per_edition_weighted",
    test: "supabase/tests/compute_pack_ev_per_edition_weighted.sql",
    migration: "supabase/migrations/20260707142744_audit_20260707_compute_pack_ev_require_varied_remaining_pool_ts.sql",
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
    fn: "compute_listing_divergence",
    test: "supabase/tests/compute_listing_divergence.sql",
    migration: "supabase/migrations/20260511060000_listing_divergence_null_safe_price.sql",
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
    fn: "promote_unmapped_sales",
    test: "supabase/tests/promote_unmapped_sales.sql",
    migration: "supabase/migrations/20260427040000_promote_unmapped_sales_archive_resolved.sql",
  },
  {
    fn: "backfill_null_serial_sales_from_moments",
    test: "supabase/tests/backfill_null_serial_sales_from_moments.sql",
    migration: "supabase/migrations/20260705193000_audit_20260705_recover_null_serial_sales_from_moments.sql",
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
