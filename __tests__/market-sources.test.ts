import { describe, it, expect, vi, beforeEach } from "vitest"

// Locks in lib/market-sources.ts::buildUnifiedEditionMarketMap — the merge layer
// that reconciles the free live-row aggregate against external, seeded-file, and
// Supabase-FMV sources per edition scope key. These tests pin the precedence
// ladders in mergeResolvedMarkets (external > live > seeded for ask/offer, but
// external > seeded > live for last-sale), the Supabase enrichment layering
// (lastSale + fmv fields, never lowAsk), null/empty handling, and the missing-env
// / error short-circuits. External + seeded maps and @supabase/supabase-js are
// mocked so only the real live aggregate + merge logic runs deterministically.

// --- mutable state driving the mocks ---
let externalMap = new Map<string, any>()
let seededMap = new Map<string, any>()
let sbState: { fmv: { data: any; error: any }; editions: { data: any; error: any } } = {
  fmv: { data: [], error: null },
  editions: { data: [], error: null },
}

vi.mock("@/lib/external-market-adapter", () => ({
  getExternalEditionMarketMap: async () => externalMap,
}))

vi.mock("@/lib/edition-market", () => ({
  getEditionMarketMap: async () => seededMap,
}))

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "limit", "is", "gte", "lt", "not", "ilike"]) {
      b[m] = () => b
    }
    b.then = (resolve: (v: any) => any) =>
      resolve(table === "fmv_current" ? sbState.fmv : sbState.editions)
    return b
  }
  return {
    createClient: () => ({
      from: (table: string) => makeBuilder(table),
      rpc: async () => ({ data: null, error: null }),
    }),
  }
})

import { buildUnifiedEditionMarketMap } from "@/lib/market-sources"

beforeEach(() => {
  externalMap = new Map()
  seededMap = new Map()
  sbState = { fmv: { data: [], error: null }, editions: { data: [], error: null } }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"
})

describe("buildUnifiedEditionMarketMap — empty + live aggregate", () => {
  it("empty rows → empty map", async () => {
    const out = await buildUnifiedEditionMarketMap([])
    expect(out.size).toBe(0)
  })

  it("live-only row → aggregate from the row itself", async () => {
    const out = await buildUnifiedEditionMarketMap([
      {
        momentId: "m1",
        editionKey: "111:222",
        lowAsk: 30,
        bestOffer: 12,
        lastPurchasePrice: 25,
      },
    ])
    const m = out.get("111:222::Base")
    expect(m).toBeDefined()
    expect(m!.lowAsk).toBe(30)
    expect(m!.bestOffer).toBe(12)
    expect(m!.lastSale).toBe(25)
    expect(m!.askCount).toBe(1)
    expect(m!.offerCount).toBe(1)
    expect(m!.saleCount).toBe(1)
    expect(m!.source).toBe("live-row-aggregate")
    expect(m!.fmvUsd).toBeNull()
  })

  it("null editionKey falls back to setName-playerName scope key", async () => {
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: null, setName: "Base Set", playerName: "LeBron", lowAsk: 5 },
    ])
    expect(out.has("Base Set-LeBron::Base")).toBe(true)
  })
})

describe("buildUnifiedEditionMarketMap — precedence", () => {
  it("external beats live for lowAsk / bestOffer", async () => {
    externalMap.set("111:222::Base", {
      scopeKey: "111:222::Base",
      lowAsk: 100,
      bestOffer: 90,
      lastSale: 80,
      askCount: 3,
      offerCount: 2,
      saleCount: 1,
      source: "external-market-json",
      notes: ["ext-note"],
      tags: ["ext"],
    })
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222", lowAsk: 30, bestOffer: 12, lastPurchasePrice: 25 },
    ])
    const m = out.get("111:222::Base")!
    expect(m.lowAsk).toBe(100)
    expect(m.bestOffer).toBe(90)
    expect(m.lastSale).toBe(80)
    expect(m.askCount).toBe(3)
    expect(m.source).toBe("external-market-json")
    expect(m.sourceChain[0]).toBe("external-market-json")
    // live source still recorded downstream in the chain
    expect(m.sourceChain).toContain("live-row-aggregate")
  })

  it("seeded fills lowAsk when live has no ask signal", async () => {
    seededMap.set("111:222::Base", {
      scopeKey: "111:222::Base",
      lowAsk: 55,
      bestOffer: null,
      lastSale: null,
      source: "edition-market-file",
      notes: [],
      tags: [],
    })
    const out = await buildUnifiedEditionMarketMap([
      // row present (so scope key exists) but carries no prices
      { momentId: "m1", editionKey: "111:222" },
    ])
    const m = out.get("111:222::Base")!
    expect(m.lowAsk).toBe(55)
    // seeded supplied the ask, but the live aggregate still heads the source chain
    expect(m.sourceChain).toContain("edition-market-file")
    expect(m.source).toBe("live-row-aggregate")
  })

  it("last-sale ladder prefers seeded over live (distinct from the ask ladder)", async () => {
    seededMap.set("111:222::Base", {
      scopeKey: "111:222::Base",
      lowAsk: null,
      bestOffer: null,
      lastSale: 70,
      source: "edition-market-file",
      notes: [],
      tags: [],
    })
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222", lastPurchasePrice: 25 },
    ])
    const m = out.get("111:222::Base")!
    // seeded (70) wins over the live lastPurchasePrice (25)
    expect(m.lastSale).toBe(70)
  })

  it("dedupes source chain / notes / tags across sources", async () => {
    externalMap.set("111:222::Base", {
      scopeKey: "111:222::Base",
      lowAsk: 100,
      bestOffer: null,
      lastSale: null,
      askCount: 1,
      offerCount: 0,
      saleCount: 0,
      source: "shared-src",
      notes: ["dupe"],
      tags: ["t"],
    })
    seededMap.set("111:222::Base", {
      scopeKey: "111:222::Base",
      lowAsk: 50,
      bestOffer: null,
      lastSale: null,
      source: "shared-src",
      notes: ["dupe"],
      tags: ["t"],
    })
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222", lowAsk: 10 },
    ])
    const m = out.get("111:222::Base")!
    // "shared-src" appears in both external + seeded but is deduped to one entry
    expect(m.sourceChain.filter((s) => s === "shared-src")).toHaveLength(1)
    // "dupe" note is shared by external + seeded → collapsed once (live adds its own)
    expect(m.notes.filter((n) => n === "dupe")).toHaveLength(1)
    expect(m.tags.filter((t) => t === "t")).toHaveLength(1)
  })
})

describe("buildUnifiedEditionMarketMap — Supabase enrichment", () => {
  // getSupabaseMarketMap now reads `editions` (scoped by the requested
  // external_ids) then `fmv_current` (latest-per-edition), keying by
  // `${external_id}::Base`. It no longer touches the nonexistent
  // `editions.parallel_tier` column (which used to error the whole read to
  // empty) nor a global fmv_snapshots window (which the 1,000-row cap truncated).
  function seedSupabase(scopeExternalId: string, fmv: number) {
    sbState.fmv.data = [
      { edition_id: "e1", fmv_usd: fmv, confidence: "HIGH", computed_at: "2026-01-01T00:00:00Z" },
    ]
    sbState.editions.data = [{ id: "e1", external_id: scopeExternalId }]
  }

  it("layers Supabase FMV lastSale + fmv fields when live/external are silent", async () => {
    seedSupabase("111:222", 50)
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222" }, // no prices anywhere else
    ])
    const m = out.get("111:222::Base")!
    expect(m.lastSale).toBe(50)
    expect(m.fmvUsd).toBe(50)
    expect(m.fmvConfidence).toBe("HIGH")
    expect(m.fmvComputedAt).toBe("2026-01-01T00:00:00Z")
    // supabase never supplies lowAsk (code hardcodes null) → stays null
    expect(m.lowAsk).toBeNull()
  })

  it("does NOT override an existing live lastSale with Supabase FMV", async () => {
    seedSupabase("111:222", 999)
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222", lastPurchasePrice: 25 },
    ])
    const m = out.get("111:222::Base")!
    expect(m.lastSale).toBe(25) // live wins; supabase only fills nulls
    // fmv-specific fields still carried through
    expect(m.fmvUsd).toBe(999)
  })

  it("uses fmv_current's latest-per-edition row (dedup happens in the view, not JS)", async () => {
    // fmv_current is DISTINCT ON (edition_id) latest, so the scoped read returns
    // one row per edition — the map simply reflects it.
    sbState.fmv.data = [
      { edition_id: "e1", fmv_usd: 60, confidence: "HIGH", computed_at: "2026-02-02" },
    ]
    sbState.editions.data = [{ id: "e1", external_id: "111:222" }]
    const out = await buildUnifiedEditionMarketMap([{ momentId: "m1", editionKey: "111:222" }])
    const m = out.get("111:222::Base")!
    expect(m.fmvUsd).toBe(60)
    expect(m.fmvConfidence).toBe("HIGH")
  })

  it("keys enrichment by external_id::Base, so a non-Base parallel scope key is not enriched", async () => {
    // The removed parallel_tier column used to (attempt to) key parallels; now
    // the map is Base-keyed, so a row asking for a non-Base parallel scope key
    // gets no Supabase FMV (its parallel lives in the external_id itself for the
    // editions this ever covered). The Base key for the same external_id IS set.
    sbState.fmv.data = [
      { edition_id: "e1", fmv_usd: 44, confidence: "MEDIUM", computed_at: "2026-03-03" },
    ]
    sbState.editions.data = [{ id: "e1", external_id: "111:222" }]
    const out = await buildUnifiedEditionMarketMap([
      { momentId: "m1", editionKey: "111:222", parallel: "Hexwave" },
    ])
    // The requested scope key is the parallel one → no Supabase FMV lands on it.
    const parallelRow = out.get("111:222::Hexwave")
    expect(parallelRow?.fmvUsd ?? null).toBeNull()
  })
})

describe("buildUnifiedEditionMarketMap — Supabase short-circuits", () => {
  it("missing env → no Supabase enrichment, fmv fields null", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    sbState.fmv.data = [
      { edition_id: "e1", fmv_usd: 50, confidence: "HIGH", computed_at: "2026-01-01" },
    ]
    sbState.editions.data = [{ id: "e1", external_id: "111:222" }]
    const out = await buildUnifiedEditionMarketMap([{ momentId: "m1", editionKey: "111:222" }])
    const m = out.get("111:222::Base")!
    expect(m.fmvUsd).toBeNull()
    expect(m.lastSale).toBeNull()
  })

  it("fmv_current query error → returns without enrichment", async () => {
    // editions resolve first, so the code reaches the fmv_current read, which errors.
    sbState.editions.data = [{ id: "e1", external_id: "111:222" }]
    sbState.fmv = { data: null, error: { message: "boom" } }
    const out = await buildUnifiedEditionMarketMap([{ momentId: "m1", editionKey: "111:222" }])
    const m = out.get("111:222::Base")!
    expect(m.fmvUsd).toBeNull()
  })

  it("no requested edition resolves → no enrichment applied", async () => {
    sbState.fmv.data = [
      { edition_id: "e1", fmv_usd: 50, confidence: "HIGH", computed_at: "2026-01-01" },
    ]
    sbState.editions.data = [] // external_id lookup returns nothing → early return
    const out = await buildUnifiedEditionMarketMap([{ momentId: "m1", editionKey: "111:222" }])
    const m = out.get("111:222::Base")!
    expect(m.fmvUsd).toBeNull()
  })

  it("fmv_current edition_id with no matching edition meta is skipped", async () => {
    sbState.editions.data = [{ id: "e1", external_id: "111:222" }]
    sbState.fmv.data = [
      { edition_id: "missing", fmv_usd: 50, confidence: "HIGH", computed_at: "2026-01-01" },
    ]
    const out = await buildUnifiedEditionMarketMap([{ momentId: "m1", editionKey: "111:222" }])
    const m = out.get("111:222::Base")!
    expect(m.fmvUsd).toBeNull()
  })
})
