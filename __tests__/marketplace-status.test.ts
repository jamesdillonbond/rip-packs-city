import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/marketplace-status.ts — the per-collection marketplace-status read.
// getMarketplaceStatus wraps the DB read in next/cache unstable_cache, so we
// mock next/cache to run the underlying fn directly, and mock supabaseAdmin to
// stub the v_collection_marketplace_status row. Covers: hyphen->underscore slug
// normalization (SLUG_TO_DB_SLUG + generic hyphen replace), the DB-row status
// mapping / boolean coercion, and the empty-slug + missing-row unknown fallbacks.

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn, // run the underlying read, skip caching
}))

const state: { single: { data: any; error: any }; eqArg: any } = {
  single: { data: null, error: null },
  eqArg: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: (_col: string, val: any) => {
        state.eqArg = val
        return b
      },
      maybeSingle: async () => state.single,
    }
    return b
  }
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

import { getMarketplaceStatus } from "@/lib/marketplace-status"

const ROW = {
  collection_id: "c1",
  slug: "ufc_strike",
  status: "shutdown",
  buy_ctas_enabled: false,
  primary_venue: "Dapper",
  primary_contract: "0xedf",
  secondary_venue: "Flowty",
  secondary_status: "dormant",
  pack_secondary_venue: null,
  last_verified_at: "2026-07-01T00:00:00Z",
  notes: "migrating to Aptos",
}

beforeEach(() => {
  state.single = { data: null, error: null }
  state.eqArg = null
})

describe("getMarketplaceStatus — slug normalization", () => {
  it("maps a frontend hyphen-slug through SLUG_TO_DB_SLUG (ufc -> ufc_strike)", async () => {
    state.single = { data: ROW, error: null }
    await getMarketplaceStatus("ufc")
    expect(state.eqArg).toBe("ufc_strike")
  })

  it("maps nba-top-shot -> nba_top_shot", async () => {
    state.single = { data: { ...ROW, slug: "nba_top_shot" }, error: null }
    await getMarketplaceStatus("nba-top-shot")
    expect(state.eqArg).toBe("nba_top_shot")
  })

  it("accepts an already-underscore DB slug as-is", async () => {
    state.single = { data: ROW, error: null }
    await getMarketplaceStatus("nba_top_shot")
    expect(state.eqArg).toBe("nba_top_shot")
  })

  it("falls back to a generic hyphen->underscore replace for unknown slugs", async () => {
    state.single = { data: null, error: null }
    await getMarketplaceStatus("some-new-chain")
    expect(state.eqArg).toBe("some_new_chain")
  })
})

describe("getMarketplaceStatus — mapping & fallbacks", () => {
  it("maps a present row into the camelCase MarketplaceStatus shape", async () => {
    state.single = { data: { ...ROW, buy_ctas_enabled: true }, error: null }
    const s = await getMarketplaceStatus("ufc")
    expect(s).toMatchObject({
      collectionId: "c1",
      slug: "ufc_strike",
      status: "shutdown",
      buyCtasEnabled: true,
      primaryVenue: "Dapper",
      primaryContract: "0xedf",
      secondaryVenue: "Flowty",
      secondaryStatus: "dormant",
      packSecondaryVenue: null,
      lastVerifiedAt: "2026-07-01T00:00:00Z",
      notes: "migrating to Aptos",
    })
  })

  it("coerces a truthy/falsy buy_ctas_enabled to a boolean", async () => {
    state.single = { data: { ...ROW, buy_ctas_enabled: null }, error: null }
    expect((await getMarketplaceStatus("ufc")).buyCtasEnabled).toBe(false)
  })

  it("returns the unknown fallback (slug set) when the row is missing", async () => {
    state.single = { data: null, error: null }
    const s = await getMarketplaceStatus("ufc")
    expect(s.status).toBe("unknown")
    expect(s.buyCtasEnabled).toBe(false)
    expect(s.slug).toBe("ufc_strike")
    expect(s.collectionId).toBe("")
  })

  it("returns the unknown fallback on a DB error", async () => {
    state.single = { data: ROW, error: { message: "boom" } }
    expect((await getMarketplaceStatus("ufc")).status).toBe("unknown")
  })

  it("returns a bare unknown fallback (no DB read) for an empty slug", async () => {
    const spyRow = { data: ROW, error: null }
    state.single = spyRow
    const s = await getMarketplaceStatus("")
    expect(s.status).toBe("unknown")
    expect(s.slug).toBe("")
    expect(state.eqArg).toBeNull() // never reached the query
  })

  it("defaults an absent status to 'unknown' even when the row exists", async () => {
    state.single = { data: { ...ROW, status: null }, error: null }
    expect((await getMarketplaceStatus("ufc")).status).toBe("unknown")
  })
})
