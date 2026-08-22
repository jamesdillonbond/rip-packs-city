import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  installFetchMock,
  gqlRoute,
  jsonRoute,
  makeInstrumentedSupabaseFixture,
  type InstalledFetchMock,
} from "./helpers/route-harness"

// The legs of /api/pack-ev the compute test doesn't reach. No EV math is changed
// here — the arithmetic already has its own unit coverage; what's pinned is the
// plumbing around it, all of which can silently publish a wrong number:
//
//   - the AllDay FORWARD (collectionId=nfl-all-day proxies to /api/allday-pack-ev
//     and must pass the upstream status through, not swallow it);
//   - fetchSecondaryAsk, whose result feeds computeDualPrice and therefore the
//     headline packEV — every failure mode has to degrade to null, never to 0;
//   - the CACHE-HIT branch, which re-derives the volatile dual price on every
//     request while reusing the cached grossEV (a cached packPrice would freeze
//     a stale verdict on the pack page);
//   - fetchRpcFmvMap: RPC FMV overrides the Top Shot marketplace price, so
//     newest-snapshot-wins and the >0 filter decide which price the EV uses,
//     and fmvCoverage/fmvSource report which source won;
//   - the fire-and-forget tails (edition seeding, pack_ev_history insert with
//     its CHECK-range clamp, the 15-minute dedupe, and flip detection), each of
//     which must stay non-fatal.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

const { POST } = await import("@/app/api/pack-ev/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures = {}, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(
    { editions: { data: [], error: null }, fmv_current: { data: [], error: null }, pack_ev_history: { data: [], error: null }, ...fixtures },
    opts,
  )
  state.sb = spy.fixture
  return spy
}

function editionNode(over: Record<string, unknown> = {}) {
  return {
    count: 100,
    remaining: 50,
    lastPurchasePrice: 0,
    lowAsk: 0,
    averageSalePrice: 20,
    minSerialNumber: 1,
    maxSerialNumber: 100,
    jerseyNumber: false,
    serialOne: false,
    lastMint: false,
    edition: {
      id: "ed1",
      circulationCount: 100,
      tier: "MOMENT_TIER_COMMON",
      marketplaceInfo: { averageSaleData: { averagePrice: "0" } },
      set: { id: "s1", flowName: "Base Set", flowSeriesNumber: 4 },
      play: { id: "p1", headline: "Dunk", stats: { playerName: "Curry", jerseyNumber: 30, teamAtMoment: "GSW", playCategory: "Dunk" } },
      setPlay: { circulations: { burned: 0, circulationCount: 100, forSaleByCollectors: 5, hiddenInPacks: 0, locked: 10, effectiveSupply: 100 } },
      parallelID: null,
      parallelSetPlay: { parallelName: null },
    },
    ...over,
  }
}

function dynamicResp(over: Record<string, unknown> = {}) {
  return {
    getPackListing: {
      data: {
        id: "pack1",
        forSale: true,
        isSoldOut: false,
        remaining: 50,
        dropType: "STANDARD",
        packListingContentRemaining: {
          unopened: 100,
          totalPackCount: 200,
          remainingByTier: { common: 50 },
          originalCountsByTier: { common: 100 },
        },
        ...over,
      },
    },
  }
}

function editionsResp(nodes: unknown[], pageInfo: { endCursor: string | null; hasNextPage: boolean } = { endCursor: null, hasNextPage: false }) {
  return {
    getPackListing: { data: { packEditionsV3: { pageInfo, edges: nodes.map((node) => ({ node })) } } },
  }
}

let harness: InstalledFetchMock | null = null
const post = (body: unknown, authToken?: string) =>
  new NextRequest("https://t/api/pack-ev", {
    method: "POST",
    body: JSON.stringify(body),
    ...(authToken ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
  })

/** The standard TS stubs plus a caller-chosen /api/pack-listings response. */
function stubs(packListings: unknown, opts: { editions?: unknown[] } = {}) {
  return [
    gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
    gqlRoute("GetPackEditions", { data: editionsResp(opts.editions ?? [editionNode()]) }),
    packListings as never,
  ]
}

afterEach(() => {
  harness?.restore()
  harness = null
})
beforeEach(() => {
  install()
})

describe("pack-ev — collection dispatch", () => {
  it("forwards nfl-all-day to /api/allday-pack-ev and passes the upstream status through", async () => {
    harness = installFetchMock([
      jsonRoute("allday-pack-ev", { packEV: 3.21, forwarded: true }, { status: 207 }),
    ])
    const res = await POST(post({ packListingId: "ad-1", packPrice: 9, collectionId: "nfl-all-day", packName: "AD Pack" }))
    expect(res.status).toBe(207)
    expect(await res.json()).toEqual({ packEV: 3.21, forwarded: true })
    // The forward carries the caller's price/name so the sibling can price it.
    expect(JSON.parse(String(harness.calls[0].init?.body))).toMatchObject({
      packListingId: "ad-1",
      packPrice: 9,
      packName: "AD Pack",
    })
  })

  it("404s a collection with no pack-EV implementation", async () => {
    harness = installFetchMock([])
    const res = await POST(post({ packListingId: "p", collectionId: "disney-pinnacle" }))
    expect(res.status).toBe(404)
    expect(harness.calls).toHaveLength(0)
  })
})

describe("pack-ev — secondary ask", () => {
  it("uses a cheaper secondary ask as the anchor price", async () => {
    harness = installFetchMock(
      stubs(jsonRoute("pack-listings", { listings: [{ distId: "d1", lowestAsk: 2, listingCount: 4 }] })),
    )
    const body = await (await POST(post({ packListingId: "sec-1", packPrice: 15, collectionId: "nba-top-shot", distId: "d1" }))).json()
    expect(body.secondaryAsk).toBe(2)
    expect(body.priceSource).toBe("secondary")
    expect(body.packPrice).toBe(2)
  })

  for (const [label, stub] of [
    ["a non-2xx response", jsonRoute("pack-listings", {}, { status: 500 })],
    ["a payload with no matching distId", jsonRoute("pack-listings", { listings: [{ distId: "other", lowestAsk: 2, listingCount: 1 }] })],
    ["a non-positive ask", jsonRoute("pack-listings", { listings: [{ distId: "d1", lowestAsk: 0, listingCount: 1 }] })],
    ["a thrown fetch", { match: (u: string) => u.includes("pack-listings"), respond: () => { throw new Error("socket") } }],
  ] as const) {
    it(`degrades to no secondary ask on ${label}`, async () => {
      harness = installFetchMock(stubs(stub))
      const body = await (await POST(post({ packListingId: `sec-${label.length}-${label.slice(0, 4)}`, packPrice: 15, collectionId: "nba-top-shot", distId: "d1" }))).json()
      expect(body.secondaryAsk).toBeNull()
      expect(body.priceSource).toBe("primary")
    })
  }

  it("skips the ask lookup entirely when no distId is supplied", async () => {
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "sec-nodist", packPrice: 15, collectionId: "nba-top-shot" }))
    expect(harness.calls.some((c) => c.url.includes("pack-listings"))).toBe(false)
  })
})

describe("pack-ev — RPC FMV override", () => {
  it("prefers the newest positive RPC FMV over the marketplace price and reports the coverage", async () => {
    install({
      editions: { data: [{ id: "uuid-1", external_id: "s1:p1" }], error: null },
      fmv_current: {
        // fmv_current is DISTINCT-ON latest-per-edition → exactly one (latest) row.
        data: [
          { edition_id: "uuid-1", fmv_usd: 40, computed_at: "2026-07-20" },
        ],
        error: null,
      },
    })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))

    const body = await (await POST(post({ packListingId: "fmv-1", packPrice: 5, collectionId: "nba-top-shot" }))).json()
    expect(body.fmvSource).toBe("rpc")
    expect(body.fmvCoverage).toBe(100)
    // 50/100 * 40 * 0.95 = 19 (marketplace price 20 would have given 9.5)
    expect(body.grossEV).toBe(19)
    expect(body.fmvCoverageNote).toBeNull()
  })

  it("ignores a non-positive FMV and falls back to the marketplace price", async () => {
    install({
      editions: { data: [{ id: "uuid-1", external_id: "s1:p1" }], error: null },
      fmv_current: { data: [{ edition_id: "uuid-1", fmv_usd: 0, computed_at: "2026-07-20" }], error: null },
    })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    const body = await (await POST(post({ packListingId: "fmv-0", packPrice: 5, collectionId: "nba-top-shot" }))).json()
    expect(body.fmvSource).toBe("topshot")
    expect(body.fmvCoverage).toBe(0)
    expect(body.fmvCoverageNote).toContain("FMV data is limited")
  })

  it("seeds the editions it could not price, so the next run has rows to snapshot", async () => {
    const spy = install()
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "seed-1", packPrice: 5, collectionId: "nba-top-shot" }))
    const seed = (spy.writes.editions ?? []).find((w) => w.method === "upsert")
    expect(seed?.rows).toEqual([{ external_id: "s1:p1" }])
  })
})

describe("pack-ev — cache + history tail", () => {
  it("serves the cached grossEV but re-derives the volatile dual price", async () => {
    harness = installFetchMock(
      stubs(jsonRoute("pack-listings", { listings: [{ distId: "d1", lowestAsk: 2, listingCount: 1 }] })),
    )
    const first = await (await POST(post({ packListingId: "cache-1", packPrice: 15, collectionId: "nba-top-shot", distId: "d1" }))).json()
    expect(first.cached).toBe(false)

    // Same pack, a different secondary ask, and NO GQL stubs at all: a cache hit
    // must not re-fetch the pack, but must re-price it.
    harness.restore()
    harness = installFetchMock([
      jsonRoute("pack-listings", { listings: [{ distId: "d1", lowestAsk: 8, listingCount: 1 }] }),
    ])
    const second = await (await POST(post({ packListingId: "cache-1", packPrice: 15, collectionId: "nba-top-shot", distId: "d1" }))).json()
    expect(second.cached).toBe(true)
    expect(second.grossEV).toBe(first.grossEV)
    expect(second.secondaryAsk).toBe(8)
    expect(second.packPrice).toBe(8)
    // Same grossEV, new anchor price -> a different headline verdict.
    expect(first.packEV).toBe(7.5)
    expect(second.packEV).toBe(1.5)
    expect(second.evVerdict).toContain("+EV by $1.50")
  })

  it("writes a clamped pack_ev_history row when no recent snapshot exists (AUTHORISED)", async () => {
    // ⚠ UPDATED for deep-audit R24. This previously posted ANONYMOUSLY with a
    // caller-supplied packPrice and asserted the row was written — i.e. it pinned
    // the defect: /api/pack-ev is open to anonymous POST, and the body's
    // packPrice became the persisted pack_price via a SERVICE_ROLE client,
    // driving pack_ev / value_ratio / is_positive_ev.
    //
    // The write itself is legitimate work for an AUTHORISED caller, so the test
    // keeps its assertions and gains a bearer token. The anonymous case is now
    // covered separately below, in both directions.
    vi.stubEnv("CRON_SECRET", "test-cron-secret")
    const spy = install({ pack_ev_history: { data: [], error: null } })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "hist-1", packPrice: 5, collectionId: "nba-top-shot", distId: "d9", packName: "Hist Pack" }, "test-cron-secret"))
    await new Promise((r) => setTimeout(r, 0))

    const row = (spy.writes.pack_ev_history ?? []).find((w) => w.method === "insert")?.rows[0]
    expect(row).toMatchObject({
      pack_listing_id: "hist-1",
      collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
      dist_id: "d9",
      pack_name: "Hist Pack",
      price_source: "primary",
    })
    expect(Number(row!.gross_ev)).toBeLessThanOrEqual(1_000_000)
    expect(Number(row!.pack_ev)).toBeGreaterThanOrEqual(-10_000)
    vi.unstubAllEnvs()
  })

  it("R24: an ANONYMOUS caller cannot persist a price it supplied", async () => {
    // The whole point of the gate. priceSource here is "primary", meaning
    // dual.packPrice IS the body's packPrice.
    vi.stubEnv("CRON_SECRET", "test-cron-secret")
    const spy = install({ pack_ev_history: { data: [], error: null } })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "anon-1", packPrice: 5, collectionId: "nba-top-shot", distId: "d9", packName: "Anon Pack" }))
    await new Promise((r) => setTimeout(r, 0))

    expect((spy.writes.pack_ev_history ?? []).filter((w) => w.method === "insert")).toHaveLength(0)
    vi.unstubAllEnvs()
  })

  it("R24: the gate FAILS CLOSED when no secret is configured", async () => {
    // An unset CRON_SECRET/INGEST_SECRET_TOKEN must not authorise everyone. A
    // `auth === \`Bearer \${undefined}\`` style comparison would do exactly that.
    vi.unstubAllEnvs()
    const spy = install({ pack_ev_history: { data: [], error: null } })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "noenv-1", packPrice: 5, collectionId: "nba-top-shot" }, "anything"))
    await new Promise((r) => setTimeout(r, 0))

    expect((spy.writes.pack_ev_history ?? []).filter((w) => w.method === "insert")).toHaveLength(0)
  })

  it("skips the history insert when one landed inside the 15-minute window", async () => {
    const spy = install({ pack_ev_history: { data: [{ id: 1 }], error: null } })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    await POST(post({ packListingId: "hist-2", packPrice: 5, collectionId: "nba-top-shot" }))
    await new Promise((r) => setTimeout(r, 0))
    expect((spy.writes.pack_ev_history ?? []).filter((w) => w.method === "insert")).toHaveLength(0)
  })

  it("keeps a failed history insert non-fatal", async () => {
    install({
      pack_ev_history: [
        { data: [], error: null }, // recency probe
        { data: null, error: { message: "history down" } }, // insert
      ],
    })
    harness = installFetchMock(stubs(jsonRoute("pack-listings", { listings: [] })))
    const res = await POST(post({ packListingId: "hist-3", packPrice: 5, collectionId: "nba-top-shot" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(res.status).toBe(200)
  })
})

describe("pack-ev — upstream failures", () => {
  it("502s when the editions query fails", async () => {
    harness = installFetchMock([
      gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
      gqlRoute("GetPackEditions", { errors: [{ message: "editions boom" }] }),
      jsonRoute("pack-listings", { listings: [] }),
    ])
    const res = await POST(post({ packListingId: "fail-ed", collectionId: "nba-top-shot" }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("Failed to fetch pack editions")
  })

  it("stops paginating editions at the 20-page safety valve", async () => {
    harness = installFetchMock([
      gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
      // Always claims another page -> the valve is the only thing that ends it.
      gqlRoute("GetPackEditions", { data: editionsResp([editionNode()], { endCursor: "c", hasNextPage: true }) }),
      jsonRoute("pack-listings", { listings: [] }),
    ])
    const body = await (await POST(post({ packListingId: "pages-1", packPrice: 5, collectionId: "nba-top-shot" }))).json()
    expect(body.editionCount).toBe(20)
    expect(harness.calls.filter((c) => String(c.init?.body).includes("GetPackEditions"))).toHaveLength(20)
  })

  it("500s with the message when a malformed edition breaks the compute loop", async () => {
    harness = installFetchMock([
      gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
      gqlRoute("GetPackEditions", {
        data: editionsResp([editionNode({ edition: { id: "bad", set: { id: "s1" }, play: { id: "p1" } } })]),
      }),
      jsonRoute("pack-listings", { listings: [] }),
    ])
    const res = await POST(post({ packListingId: "malformed-1", packPrice: 5, collectionId: "nba-top-shot" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBeTruthy()
  })
})
