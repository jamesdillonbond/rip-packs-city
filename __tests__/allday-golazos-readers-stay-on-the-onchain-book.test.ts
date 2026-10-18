import { describe, it, expect } from "vitest"
import { newestDefinitions, migrationFiles } from "./helpers/migration-defs"

// For NFL All Day and LaLiga Golazos, v1 `cached_listings` holds Flowty's book
// ALONE (108 / 100 rows on 2026-10-18, against ~34k / ~4.3k open asks in the
// on-chain index, cached_listings_v2). On 10-18 four user-facing readers were
// found answering from it — the Golazos Market page, the Order Book Depth card,
// the Sniper's relative deals and its tier benchmarks — and moved to v2
// (Flowty retirement runbook, step 0).
//
// POPULATION (a tree walk): the NEWEST definition of every function / view /
// materialized view in supabase/migrations whose comment-stripped body reads
// v1 `cached_listings`. Banned at zero; SUPPRESSED is the curated list, each
// with why it may still read v1. A new v1 reader fails here until someone
// states why it is not an All Day / Golazos answer.

const V1_READ = /\b(?:from|join)\s+(?:public\.)?cached_listings\b(?!_)/i

const SUPPRESSED: Record<string, string> = {
  // Reads v1 for Top Shot (its own feed: 25k `source='topshot'` rows); All Day
  // and Golazos come from its `onchain` arm — pinned by EXCLUDES_INDEX_COLLECTIONS below.
  analytics_listings_summary: "Top Shot arm only; All Day + Golazos excluded from the v1 arm",
  get_collection_stats: "listing_count is read by no rendered surface (runbook triage); moves with Flowty step 3",
  get_platform_stats: "listing_count is read by no rendered surface (runbook triage); moves with Flowty step 3",
  fmv_from_cached_listings: "returns 0 for All Day and Golazos before reading (their ASK_ONLY lanes read v2)",
  update_badge_low_ask_from_cached_listings: "Top Shot badge low-ask aggregator; no All Day / Golazos rows in badge_editions",
  sync_cached_listings_from_atlas: "the Top Shot v1 WRITER (Atlas feed), not an All Day / Golazos reader",
  analytics_pipeline_health: "admin pipeline-health page, counts per source",
  mcp_find_set_completion: "no caller in app, lib, scripts or edge functions (runbook census 10-18)",
  compute_ultimate_non_special_fmv: "Top Shot Ultimate-tier FMV only; no caller in app, lib, scripts or edge functions",
  resolve_wallet_verification_challenges:
    "listing-challenge verification: its v1 leg is Top Shot's own feed; All Day / Golazos match through its v2 leg (pinned below)",
}

// The readers moved on 10-18: each must read v2 and must not read v1.
const MOVED_TO_V2 = [
  "get_relative_deals",
  "get_tier_pricing_benchmarks",
  "get_golazos_market_editions",
  "get_golazos_catalog_deals",
]

// cached_listings_v2 itself, or the edition floor views defined over it.
const ON_CHAIN_READ = /\b(?:cached_listings_v2|allday_edition_floor_ask|golazos_edition_floor_ask)\b/i

const EXCLUDES_INDEX_COLLECTIONS = /c\.slug\s+NOT\s+IN\s*\(\s*'nfl_all_day'\s*,\s*'laliga_golazos'\s*\)/i

function v1Readers(defs: ReturnType<typeof newestDefinitions>): string[] {
  return [...defs].filter(([, d]) => !d.dropped && V1_READ.test(d.body)).map(([o]) => o).sort()
}

describe("All Day / Golazos listing readers stay on the on-chain book", () => {
  const defs = newestDefinitions(migrationFiles())

  it("inspects a real population", () => {
    expect(defs.size).toBeGreaterThan(800)
    // A population that collapsed to 0 would pass the ban vacuously.
    expect(v1Readers(defs).length).toBeGreaterThanOrEqual(5)
  })

  it("no v1 cached_listings reader outside the curated suppressions", () => {
    const offenders = v1Readers(defs).filter((o) => !(o in SUPPRESSED))
    expect(offenders).toEqual([])
  })

  it("every suppression still names a live v1 reader (no stale entries)", () => {
    const readers = new Set(v1Readers(defs))
    expect(Object.keys(SUPPRESSED).filter((o) => !readers.has(o))).toEqual([])
  })

  it("the 10-18 readers read the on-chain book and not v1", () => {
    for (const fn of MOVED_TO_V2) {
      const d = defs.get(fn)
      expect(d, fn).toBeDefined()
      expect(d!.dropped, fn).toBe(false)
      expect(V1_READ.test(d!.body), `${fn} reads v1 cached_listings`).toBe(false)
      expect(ON_CHAIN_READ.test(d!.body), `${fn} no longer reads the on-chain book`).toBe(true)
    }
  })

  it("wallet verification keeps its on-chain leg (an All Day / Golazos-only wallet can verify)", () => {
    const body = defs.get("resolve_wallet_verification_challenges")!.body
    expect(body).toMatch(/\bcached_listings_v2\b/i)
    // the leg must accept storefront_v2 rows, whose listed_at is NULL
    expect(body).toMatch(/COALESCE\(\s*c2\.listed_at\s*,\s*c2\.ingested_at\s*\)\s*>=\s*wvc\.created_at/i)
  })

  it("analytics_listings_summary's v1 arm excludes All Day and Golazos, and its on-chain arm exists", () => {
    const body = defs.get("analytics_listings_summary")!.body
    expect(body).toMatch(EXCLUDES_INDEX_COLLECTIONS)
    expect(body).toMatch(/\bcached_listings_v2\b/i)
  })

  // Planted defects: the detectors must see what they claim to.
  it("detectors fire on a planted v1 read and a dropped exclusion", () => {
    expect(V1_READ.test("SELECT 1 FROM public.cached_listings cl")).toBe(true)
    expect(V1_READ.test("SELECT 1 FROM cached_listings_v2 cl")).toBe(false)
    expect(V1_READ.test("x JOIN cached_listings l ON true")).toBe(true)
    expect(EXCLUDES_INDEX_COLLECTIONS.test("WHERE cl.ask_price > 0 AND (p_collections IS NULL)")).toBe(false)
  })
})
