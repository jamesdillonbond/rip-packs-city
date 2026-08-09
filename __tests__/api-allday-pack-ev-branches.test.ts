import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// allday-pack-ev — branch coverage for the paths the two sibling files leave dark:
//   • the cache-HIT return (a second call for the same packListingId) and its 3
//     evVerdict arms (price 0 / +EV / -EV),
//   • the 502 / 404 / bundle-200 error returns,
//   • the RPC-FMV-matched path (priceSource "rpc" / fmvSource "rpc" / the
//     coverage-note tiers: >=50 → null, 10–50 → partial),
//   • missing set/play/circulation fallbacks ("Unknown", ?? 0),
//   • the edition-seeding hydrate-vs-fallback split + the tier IIFE variants,
//   • the >20-page pagination break, and the upsert-error swallow.
// Everything routes through the real POST handler; the gql + supabase seams are
// mutable per test via the two hoisted controllers below.

const gql = vi.hoisted(() => ({
  // dynamic-supply query result; an Error value means "throw".
  dynamic: null as any,
  editionsPages: [] as any[], // per-cursor pages: [{pageInfo, edges}, ...]
  editionsThrow: false,
  editionsInfinite: false, // every page reports hasNextPage:true → force the >20 break
}))

const sb = vi.hoisted(() => ({
  editionRows: [] as any[], // rows the `editions` select returns in fetchRpcFmvMap
  snapshots: [] as any[], // rows the `fmv_current` select returns
  upsertError: null as any, // toggled to exercise the seed-upsert error branch
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: any = { _t: table, _upsert: false }
      b.select = () => b
      b.in = () => b
      b.eq = () => b
      b.order = () => b
      b.upsert = () => {
        b._upsert = true
        return b
      }
      b.insert = () => b
      b.then = (resolve: any) => {
        if (table === "fmv_current") return resolve({ data: sb.snapshots, error: null })
        if (table === "editions" && b._upsert) return resolve({ error: sb.upsertError })
        if (table === "editions") return resolve({ data: sb.editionRows, error: null })
        return resolve({ data: null, error: null }) // pipeline_runs insert etc.
      }
      return b
    },
  }),
}))

vi.mock("@/lib/chains/flow/allday", () => ({
  alldayGraphql: async (query: string, vars: any) => {
    if (query.includes("packEditionsV3")) {
      if (gql.editionsThrow) throw new Error("editions upstream boom")
      const idx = vars?.after == null ? 0 : Number(vars.after)
      if (gql.editionsInfinite) {
        return {
          getPackListing: {
            data: {
              packEditionsV3: {
                pageInfo: { endCursor: String(idx + 1), hasNextPage: true },
                edges: [{ node: fullNode(idx, { averageSalePrice: 5 }) }],
              },
            },
          },
        }
      }
      const page = gql.editionsPages[idx] ?? { pageInfo: { endCursor: null, hasNextPage: false }, edges: [] }
      return { getPackListing: { data: { packEditionsV3: page } } }
    }
    // dynamic supply query
    if (gql.dynamic instanceof Error) throw gql.dynamic
    return gql.dynamic
  },
}))

// A fully-shaped edition node; `i` gives it a distinct set:play external id.
function fullNode(i: number, overrides: Record<string, any> = {}) {
  return {
    count: 10,
    remaining: 5,
    lastPurchasePrice: 0,
    lowAsk: 0,
    averageSalePrice: 0,
    minSerialNumber: 1,
    maxSerialNumber: 10,
    jerseyNumber: false,
    serialOne: false,
    lastMint: false,
    edition: {
      id: `ed${i}`,
      circulationCount: 10,
      tier: "MOMENT_TIER_COMMON",
      marketplaceInfo: { averageSaleData: { averagePrice: "0" } },
      set: { id: `s${i}`, flowName: `Set ${i}`, flowSeriesNumber: 1 },
      play: {
        id: `p${i}`,
        headline: "h",
        stats: { playerName: `Player ${i}`, jerseyNumber: "7", teamAtMoment: "Team", playCategory: "Cat" },
      },
      setPlay: {
        circulations: { burned: 0, circulationCount: 10, forSaleByCollectors: 0, hiddenInPacks: 0, locked: 0, effectiveSupply: 10 },
      },
      parallelID: 0,
      parallelSetPlay: { parallelName: "" },
    },
    ...overrides,
  }
}

// Dynamic-supply response with sane defaults; override contentRemaining / listing flags per test.
function dyn(over: Record<string, any> = {}) {
  return {
    getPackListing: {
      data: {
        id: "pack1",
        forSale: true,
        isSoldOut: false,
        remaining: 5,
        dropType: "STANDARD",
        packListingContentRemaining: { unopened: 100, totalPackCount: 200, remainingByTier: {}, originalCountsByTier: {} },
        ...over,
      },
    },
  }
}

function onePage(nodes: any[]) {
  return [{ pageInfo: { endCursor: null, hasNextPage: false }, edges: nodes.map((n) => ({ node: n })) }]
}

const { POST } = await import("@/app/api/allday-pack-ev/route")

let seq = 0
function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-pack-ev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
async function run(body: Record<string, any> = {}) {
  const id = body.packListingId ?? `pack-b-${++seq}`
  const res = await POST(req({ packPrice: 5, ...body, packListingId: id }))
  return { res, body: await res.json(), id }
}

beforeEach(() => {
  gql.dynamic = dyn()
  gql.editionsPages = onePage([fullNode(1, { averageSalePrice: 20 })])
  gql.editionsThrow = false
  gql.editionsInfinite = false
  sb.editionRows = []
  sb.snapshots = []
  sb.upsertError = null
})

describe("allday-pack-ev — cache-hit return + evVerdict arms", () => {
  it("returns cached:true on the second call and recomputes the verdict for each packPrice", async () => {
    const id = `pack-cache-${++seq}`
    // First call populates the cache (grossEV = 0.05 * 20 * 0.95 = 0.95).
    const first = await run({ packListingId: id, packPrice: 0 })
    expect(first.body.cached).toBe(false)
    expect(first.body.grossEV).toBeCloseTo(0.95, 2)

    // packPrice 0 → "set pack price" verdict, served from cache.
    const zero = await run({ packListingId: id, packPrice: 0 })
    expect(zero.body.cached).toBe(true)
    expect(zero.body.evVerdict).toMatch(/Set pack price/)

    // packPrice below grossEV → +EV verdict, cached.
    const pos = await run({ packListingId: id, packPrice: 0.01 })
    expect(pos.body.cached).toBe(true)
    expect(pos.body.packEV).toBeGreaterThan(0)
    expect(pos.body.evVerdict).toMatch(/\+EV/)

    // packPrice above grossEV → -EV verdict, cached.
    const neg = await run({ packListingId: id, packPrice: 100 })
    expect(neg.body.cached).toBe(true)
    expect(neg.body.packEV).toBeLessThan(0)
    expect(neg.body.evVerdict).toMatch(/-EV/)
  })
})

describe("allday-pack-ev — error returns", () => {
  it("400 when packListingId is missing", async () => {
    const res = await POST(req({ packPrice: 5 }))
    expect(res.status).toBe(400)
  })

  it("502 when the dynamic supply query fails", async () => {
    gql.dynamic = new Error("supply upstream down")
    const { res, body } = await run()
    expect(res.status).toBe(502)
    expect(body.error).toMatch(/Failed to fetch pack supply data/)
  })

  it("502 when the editions query fails", async () => {
    gql.editionsThrow = true
    const { res, body } = await run()
    expect(res.status).toBe(502)
    expect(body.error).toMatch(/Failed to fetch pack editions/)
  })

  it("200 bundle_not_supported when the pack has zero editions", async () => {
    gql.editionsPages = onePage([])
    const { res, body } = await run()
    expect(res.status).toBe(200)
    expect(body.error).toBe("bundle_not_supported")
  })

  it("404 when there are no unopened packs", async () => {
    gql.dynamic = dyn({ packListingContentRemaining: { unopened: 0, totalPackCount: 0, remainingByTier: {}, originalCountsByTier: {} } })
    const { res, body } = await run()
    expect(res.status).toBe(404)
    expect(body.error).toBe("No pack data available")
  })
})

describe("allday-pack-ev — RPC FMV matched path + coverage-note tiers", () => {
  it("prices from RPC FMV (priceSource/fmvSource 'rpc') with a null coverage note at 100%", async () => {
    gql.editionsPages = onePage([fullNode(1)]) // ext s1:p1, no other price source
    sb.editionRows = [{ id: "e1", external_id: "s1:p1" }]
    sb.snapshots = [{ edition_id: "e1", fmv_usd: 50 }]
    const { body } = await run()
    expect(body.topPulls[0].priceSource).toBe("rpc")
    expect(body.fmvSource).toBe("rpc")
    expect(body.fmvCoverage).toBe(100)
    expect(body.fmvCoverageNote).toBeNull()
    expect(body.grossEV).toBeCloseTo(2.38, 2) // 0.05 * 50 * 0.95
  })

  it("emits the partial (10–50%) coverage note when a minority of editions are RPC-priced", async () => {
    gql.editionsPages = onePage([
      fullNode(1),
      fullNode(2, { averageSalePrice: 10 }),
      fullNode(3, { averageSalePrice: 10 }),
      fullNode(4, { averageSalePrice: 10 }),
    ])
    sb.editionRows = [{ id: "e1", external_id: "s1:p1" }]
    sb.snapshots = [{ edition_id: "e1", fmv_usd: 40 }]
    const { body } = await run()
    expect(body.fmvCoverage).toBe(25)
    expect(body.fmvCoverageNote).toMatch(/Partial FMV coverage/)
    expect(body.fmvSource).toBe("rpc")
  })
})

describe("allday-pack-ev — missing-field fallbacks", () => {
  it("falls back to Unknown player/set and null external id when set/play/circulations are absent", async () => {
    const bare = fullNode(9)
    bare.edition.set = undefined as any
    bare.edition.play = undefined as any
    bare.edition.setPlay = undefined as any
    bare.averageSalePrice = 12
    gql.editionsPages = onePage([bare])
    const { body } = await run()
    const pull = body.topPulls[0]
    expect(pull.playerName).toBe("Unknown")
    expect(pull.setName).toBe("Unknown")
    expect(pull.lockedPct).toBe(0)
    expect(pull.locked).toBe(0)
    expect(pull.hiddenInPacks).toBe(0)
    // No external id ⇒ nothing to seed and nothing to RPC-match.
    expect(body.fmvSource).toBe("allday")
  })
})

describe("allday-pack-ev — edition seeding (hydrate vs fallback + tier variants)", () => {
  it("processes hydrated and skeleton rows across all tier buckets without throwing", async () => {
    const ult = fullNode(11, { averageSalePrice: 8, edition: { ...fullNode(11).edition, tier: "MOMENT_TIER_ULTIMATE" } })
    const leg = fullNode(12, { averageSalePrice: 8, edition: { ...fullNode(12).edition, tier: "MOMENT_TIER_LEGENDARY" } })
    const rare = fullNode(13, { averageSalePrice: 8, edition: { ...fullNode(13).edition, tier: "MOMENT_TIER_RARE" } })
    // A node whose play carries no playerName ⇒ _ok=false ⇒ counted as a fallback skeleton.
    const noName = fullNode(14, { averageSalePrice: 8 })
    noName.edition.play.stats.playerName = null as any
    // A tier the seed-map IIFE doesn't recognise ⇒ tier=null branch.
    const fandom = fullNode(15, { averageSalePrice: 8, edition: { ...fullNode(15).edition, tier: "MOMENT_TIER_FANDOM" } })
    gql.editionsPages = onePage([ult, leg, rare, noName, fandom])
    const { res, body } = await run()
    expect(res.status).toBe(200)
    // tierBreakdown is keyed by the normalized (lowercased) tier of every node.
    expect(Object.keys(body.tierBreakdown).sort()).toEqual(["common", "fandom", "legendary", "rare", "ultimate"])
  })

  it("swallows a seed-upsert error and still returns 200", async () => {
    sb.upsertError = { message: "duplicate key" }
    gql.editionsPages = onePage([fullNode(1, { averageSalePrice: 8 })])
    const { res, body } = await run()
    expect(res.status).toBe(200)
    expect(body.cached).toBe(false)
  })
})

describe("allday-pack-ev — pagination + supply-snapshot defaults", () => {
  it("breaks pagination safely after 20 pages of hasNextPage:true", async () => {
    gql.editionsInfinite = true
    const { res, body } = await run()
    expect(res.status).toBe(200)
    // 20 pages × 1 node each accumulate before the break.
    expect(body.editionCount).toBe(20)
  })

  it("defaults forSale/isSoldOut to false and depletionPct to 0 when listing flags / totalPackCount are absent", async () => {
    gql.dynamic = {
      getPackListing: {
        data: {
          // no forSale / isSoldOut keys, totalPackCount omitted
          packListingContentRemaining: { unopened: 50, remainingByTier: {}, originalCountsByTier: {} },
        },
      },
    }
    gql.editionsPages = onePage([fullNode(1, { averageSalePrice: 8 })])
    const { body } = await run()
    expect(body.supplySnapshot.forSale).toBe(false)
    expect(body.supplySnapshot.isSoldOut).toBe(false)
    expect(body.supplySnapshot.depletionPct).toBe(0)
  })
})
