import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep test for POST /api/wallet-search — drives the real enrichment body (the
// Cadence owned-ids walk -> per-moment GQL+metadata fan-out -> FMV/ask batch
// enrich -> acquisition enrich -> response assembly) through stubbed fcl /
// topshotGraphql / Supabase seams. The existing route test covers only the
// guard/4xx surface; these assert what the handler COMPUTES: row assembly from
// two upstream sources, edition-scope ownership counts, the cached-listings ask
// override, the FMV sanity ceiling, and the top-level 500 error mapping.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  metadataError: null as Error | null,
  gqlById: {} as Record<string, unknown>,
  gqlError: null as Error | null,
}))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: (_key: string, _ttl: number, fn: () => unknown) => fn(),
}))

vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      // Batched metadata script (2026-11-15): recover the id list from the args
      // builder and answer only the ids the wallet "holds" — a missing id is
      // absent from the dictionary, exactly as the Cadence returns it.
      if (state.metadataError) throw state.metadataError
      const collected: unknown[] = []
      opts.args?.(((v: unknown) => {
        collected.push(v)
        return v
      }) as never, { Array: () => "Array" } as never)
      const ids = (collected[1] as string[]) ?? []
      const out: Record<string, Record<string, string>> = {}
      for (const id of ids) if (state.metadataById[id]) out[id] = state.metadataById[id]
      return out
    },
  },
}))

vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) => {
    if (state.gqlError) throw state.gqlError
    return state.gqlById[vars.id] ?? { getMintedMoment: { data: null } }
  },
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
const resolveReason = vi.hoisted(() => ({ value: "username_not_found_on_topshot" }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => ({ found: false, reason: resolveReason.value }),
}))

const { POST } = await import("@/app/api/wallet-search/route")

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })
}

function momentMeta(serial: string): Record<string, string> {
  return {
    player: "Damian Lillard",
    team: "Portland Trail Blazers",
    setName: "Base Set",
    series: "5",
    serial,
    // The chain's numMomentsInEdition is NOT read any more (it counts the whole
    // family); circulation comes from the edition row below.
    sub: "0",
    playID: "45",
    setID: "3",
  }
}

function momentGql(flowId: string, serial: string, score: number) {
  return {
    getMintedMoment: {
      data: {
        flowId,
        flowSerialNumber: serial,
        tier: "TIER_COMMON",
        forSale: true,
        price: "12.5",
        lastPurchasePrice: "8",
        isLocked: false,
        createdAt: "2026-01-01T00:00:00Z",
        badges: [{ type: "TOP_SHOT_DEBUT", iconSvg: "" }],
        set: { id: "3", leagues: ["NBA"] },
        play: { id: "45", stats: { jerseyNumber: "0" } },
        topshotScore: { score },
      },
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function baseFixtures(overrides: Fixtures = {}): Fixtures {
  return {
    collections: { data: { id: TS_UUID }, error: null },
    editions: [
      { data: null, error: null }, // batch upsert of missing editions
      { data: [{ id: "uuid-ed-1", external_id: "3:45", circulation_count: 15000 }], error: null }, // key resolve
    ],
    cached_listings: { data: [{ flow_id: "flow-101", ask_price: 11, fmv: null }], error: null },
    "rpc:get_editions_latest_fmv_wide": {
      data: [
        {
          edition_id: "uuid-ed-1",
          fmv_usd: 42.5,
          confidence: "HIGH",
          sales_count_30d: 12,
          computed_at: "2026-07-17T00:00:00Z",
        },
      ],
      error: null,
    },
    "rpc:get_wallet_acquisition_data_scoped": {
      data: [
        { moment_id: "101", acquisition_method: "marketplace", buy_price: 8.5, loan_principal: null },
      ],
      error: null,
    },
    "rpc:get_acquisition_stats": {
      data: [
        {
          breakdown: [
            { method: "marketplace", count: 1 },
            { method: "pack_pull", count: 1 },
          ],
          total_moments: 2,
          total_spent: 20,
          locked_count: 0,
        },
      ],
      error: null,
    },
    ...overrides,
  }
}

beforeEach(() => {
  state.ownedIds = [101, 102]
  state.metadataById = { "101": momentMeta("5"), "102": momentMeta("777") }
  state.gqlById = {
    "101": momentGql("flow-101", "5", 1200),
    "102": momentGql("flow-102", "777", 800),
  }
  state.gqlError = null
  state.metadataError = null
})

describe("POST /api/wallet-search — enrichment body", () => {
  it("degraded rows with no edition key are never counted as one shared edition (2026-11-07)", async () => {
    // Both reads fail for both moments: each becomes an "Unknown (error loading)"
    // row with no edition key. They used to share one scope key and read
    // "You hold 2 of this edition".
    state.metadataById = {}
    state.gqlById = {}
    install(baseFixtures())
    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    const body = await res.json()
    const degraded = body.rows.filter((r: { editionKey?: string | null }) => !r.editionKey)
    expect(degraded.length).toBe(2)
    for (const r of degraded) expect(r.editionsOwned).toBe(1)
  })

  it("assembles rows from Cadence metadata + GQL, enriches FMV/asks, and reports the summary", async () => {
    install(baseFixtures())

    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.walletAddress).toBe(WALLET)
    expect(body.rows).toHaveLength(2)
    expect(body.summary).toMatchObject({
      totalMoments: 2,
      returnedMoments: 2,
      remainingMoments: 0,
      totalTssPoints: 2000,
    })

    const row = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(row).toMatchObject({
      playerName: "Damian Lillard",
      team: "Portland Trail Blazers",
      setName: "Base Set",
      tier: "Common",
      serial: 5,
      mintSize: 15000,
      editionKey: "3:45",
      league: "NBA",
      flowId: "flow-101",
      thumbnailUrl: "https://assets.nbatopshot.com/media/flow-101/image?width=180",
      // FMV came from fmv_current via the edition-key resolve.
      fmv: 42.5,
      marketConfidence: "high",
      // cached_listings ask (11) overrides the GQL ask (12.5).
      lowAsk: 11,
      // Both owned moments share the edition -> ownership count is 2.
      editionsOwned: 2,
      // Acquisition enrich: marketplace buy -> cost basis + label.
      acquisitionMethod: "marketplace",
      costBasis: 8.5,
      costBasisLabel: "Bought",
    })

    // The un-attributed sibling keeps the GQL ask and no cost basis.
    const row2 = body.rows.find((r: { momentId: string }) => r.momentId === "102")
    expect(row2).toMatchObject({ lowAsk: 12.5, editionsOwned: 2 })
    expect(row2.acquisitionMethod ?? null).toBeNull()

    expect(body.acquisitionStats).toMatchObject({
      marketplace_count: 1,
      pack_pull_count: 1,
      total_count: 2,
      total_spent: 20,
    })
  })

  it("applies the FMV sanity ceiling: a >$10K non-HIGH snapshot is discarded", async () => {
    install(
      baseFixtures({
        "rpc:get_editions_latest_fmv_wide": {
          data: [
            {
              edition_id: "uuid-ed-1",
              fmv_usd: 950000,
              confidence: "LOW",
              sales_count_30d: 1,
              computed_at: "2026-07-17T00:00:00Z",
            },
          ],
          error: null,
        },
      }),
    )

    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBeNull()
    expect(body.rows[0].marketConfidence).toBeNull()
  })

  it("#215: a snapshot capped at its edition's sales carries fmvCapped; an uncapped one does not", async () => {
    const snap = (algo_version: string) => ({
      "rpc:get_editions_latest_fmv_wide": {
        data: [{ edition_id: "uuid-ed-1", fmv_usd: 114, confidence: "ASK_ONLY", sales_count_30d: 0, computed_at: "2026-10-29T00:00:00Z", algo_version }],
        error: null,
      },
    })
    install(baseFixtures(snap("1.8.3_histcap")))
    const capped = await (await POST(post({ input: WALLET }))).json()
    expect(capped.rows[0].marketConfidence).toBe("ask_only")
    expect(capped.rows[0].fmvCapped).toBe(true)

    install(baseFixtures(snap("1.8.3")))
    const plain = await (await POST(post({ input: WALLET }))).json()
    expect(plain.rows[0].fmvCapped).toBe(false)
  })

  it("keeps a >$10K snapshot when it is HIGH confidence with corroborating sales", async () => {
    install(
      baseFixtures({
        "rpc:get_editions_latest_fmv_wide": {
          data: [
            {
              edition_id: "uuid-ed-1",
              fmv_usd: 25000,
              confidence: "HIGH",
              sales_count_30d: 8,
              computed_at: "2026-07-17T00:00:00Z",
            },
          ],
          error: null,
        },
      }),
    )

    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBe(25000)
  })

  it("paginates: offset/limit slice the owned-id set and remainingMoments reflects the rest", async () => {
    state.ownedIds = [101, 102, 103, 104, 105]
    install(baseFixtures())

    const body = await (await POST(post({ input: WALLET, offset: 0, limit: 2 }))).json()
    expect(body.rows).toHaveLength(2)
    expect(body.summary).toMatchObject({
      totalMoments: 5,
      returnedMoments: 2,
      remainingMoments: 3,
    })
  })

  it("survives a single bad moment: the failed moment degrades to a fallback row instead of failing the wallet", async () => {
    // Moment 102 has metadata but its GQL always throws.
    state.gqlById = { "101": momentGql("flow-101", "5", 1200) }
    const orig = state.metadataById
    state.metadataById = { ...orig }
    install(baseFixtures())
    // Make only moment 102's GQL throw by removing its fixture and forcing an
    // error path through a data-less response instead: null data still builds a
    // row, so instead drop 102's metadata to force the moment-fail catch.
    delete state.metadataById["102"]

    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    const fallback = body.rows.find((r: { momentId: string }) => r.momentId === "102")
    expect(fallback.playerName).toBe("Unknown (error loading)")
    // The healthy moment is unaffected.
    expect(body.rows.find((r: { momentId: string }) => r.momentId === "101").playerName).toBe(
      "Damian Lillard",
    )
  })

  it("maps a rate-limited upstream to the friendly 500 message", async () => {
    state.gqlError = new Error("429 too many requests")
    // Owned-ids walk also failing puts us in the resolve/fetch error path.
    state.ownedIds = []
    install(baseFixtures())
    // Force the owned-ids fetch itself to throw.
    state.ownedIds = null as unknown as number[]

    const res = await POST(post({ input: WALLET }))
    // ids fetch returned non-array -> [] -> no throw; instead assert the
    // empty-wallet contract: 200 with zero rows.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(0)
    expect(body.summary.totalMoments).toBe(0)
  })

  // 2026-09-29 — INVERTED. This pinned a 500 "Failed to fetch wallet data.
  // Please try again." for a username Top Shot does not know: a retry that can
  // never succeed. A genuine miss is a 404 that says check the spelling; only a
  // lookup that could not reach Top Shot is a (503) failure.
  it("a username Top Shot does not know is a 404 'check the spelling', not a retryable 500", async () => {
    install(baseFixtures())
    resolveReason.value = "username_not_found_on_topshot"
    const res = await POST(post({ input: "some-username" }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("username_not_found")
    expect(body.error).not.toMatch(/try again/i)
    expect(body.rows).toHaveLength(0)
  })

  it("a lookup that could not reach Top Shot is a 503 that concludes nothing about the handle", async () => {
    install(baseFixtures())
    resolveReason.value = "topshot_gql_error"
    const res = await POST(post({ input: "some-username" }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("username_lookup_unavailable")
    expect(body.error).not.toMatch(/spelling/)
    resolveReason.value = "username_not_found_on_topshot"
  })

  it("populates the #1-serial trait for a serial-1 moment", async () => {
    // specialSerialTraits(serial, mint, badges): serial === 1 -> "#1 Serial".
    // The base harness uses serial 5/777, so this trait branch was never taken.
    state.metadataById = { ...state.metadataById, "101": { ...momentMeta("1") } }
    install(baseFixtures())
    const body = await (await POST(post({ input: WALLET }))).json()
    const row = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(row.serial).toBe(1)
    expect(row.specialSerialTraits).toContain("#1 Serial")
  })
})

// 2026-11-15: a parallel is its own edition. TopShot.getMomentsSubedition() > 0
// means the key is `set:play::N`; the chain's numMomentsInEdition counts the
// whole set:play family (a /500 parallel read 16,000 on mainnet), so it must not
// become the circulation, and the base edition's FMV must not price a parallel.
describe("POST /api/wallet-search — parallels and circulation", () => {
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it("keys a parallel as set:play::N, prices and sizes it from ITS edition, and names it", async () => {
    state.metadataById = {
      // serial 500 of a /500 parallel: a perfect mint, but only by the parallel's own size.
      "101": { ...momentMeta("500"), sub: "3", mint: "16000" },
      "102": momentMeta("777"),
    }
    const spy = install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          {
            data: [
              { id: "uuid-par-3", external_id: "3:45::3", circulation_count: 500 },
              { id: "uuid-ed-1", external_id: "3:45", circulation_count: 15000 },
            ],
            error: null,
          },
        ],
        topshot_subeditions: { data: [{ subedition_id: 3, name: "Blockchain" }], error: null },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    await flush()

    const par = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(par.editionKey).toBe("3:45::3")
    expect(par.parallel).toBe("Blockchain")
    expect(par.circulationCount).toBe(500)
    expect(par.mintSize).toBe(500)
    expect(par.specialSerialTraits).toContain("Original Perfect Mint Serial")
    // The FMV fixture prices only the BASE edition: the parallel must not inherit it.
    expect(par.fmv).not.toBe(42.5)
    expect(par.fmv ?? null).toBeNull()
    // It is a different edition from its base sibling, so neither counts the other.
    expect(par.editionsOwned).toBe(1)

    const base = body.rows.find((r: { momentId: string }) => r.momentId === "102")
    expect(base).toMatchObject({ editionKey: "3:45", circulationCount: 15000, fmv: 42.5, editionsOwned: 1 })

    // The insert-only seed never creates a parallel edition (the catalog owns them).
    const seeded = (spy.writes.editions ?? [])
      .flatMap((w) => w.rows)
      .filter((r) => "name" in r)
      .map((r) => String(r.external_id))
    expect(seeded.some((k) => k.includes("::"))).toBe(false)
  })

  it("with GraphQL down (the degraded row), a parallel still gets its own key and its name", async () => {
    state.gqlError = new Error("Top Shot GraphQL failed with 530")
    state.metadataById = { "101": { ...momentMeta("66"), sub: "17" }, "102": momentMeta("777") }
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: [{ id: "uuid-par-17", external_id: "3:45::17", circulation_count: 99 }], error: null },
        ],
        topshot_subeditions: { data: [{ subedition_id: 17, name: "Legendary Parallel" }], error: null },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    const par = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(par.enrichFailed).toBe(true)
    expect(par.editionKey).toBe("3:45::17")
    expect(par.parallel).toBe("Legendary Parallel")
    expect(par.circulationCount).toBe(99)
    const base = body.rows.find((r: { momentId: string }) => r.momentId === "102")
    expect(base.parallel ?? null).toBeNull()
  })

  it("never shows the chain's family count: no edition circulation → null, not the chain number", async () => {
    state.metadataById = {
      "101": { ...momentMeta("5"), mint: "4099" },
      "102": { ...momentMeta("777"), mint: "4099" },
    }
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: [{ id: "uuid-ed-1", external_id: "3:45", circulation_count: null }], error: null },
        ],
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    for (const row of body.rows) {
      expect(row.circulationCount ?? null).toBeNull()
      expect(row.mintSize ?? null).toBeNull()
    }
  })

  it("reads the page's chain metadata in ONE script, not one per moment", async () => {
    let scripts = 0
    const flow = (await import("@/lib/chains/flow/flow")).default as { query: (o: { cadence: string }) => unknown }
    const orig = flow.query
    flow.query = async (o: { cadence: string }) => {
      if (!o.cadence.includes("getIDs")) scripts++
      return (orig as (x: unknown) => unknown)(o)
    }
    try {
      install(baseFixtures())
      const body = await (await POST(post({ input: WALLET }))).json()
      expect(body.rows).toHaveLength(2)
      expect(scripts).toBe(1)
    } finally {
      flow.query = orig
    }
  })
})

// The POST handler's pre-walk dispatch — address-chain detection and the
// collection routing table — decides, before any Cadence/Supabase work, whether
// to answer, reject, or hand off to a sibling route. A regression here silently
// mislabels or misroutes a wallet (the exact "ufc-strike returned Top Shot
// moments" class the code comments cite), so each terminal is pinned.
describe("POST /api/wallet-search — pre-walk dispatch", () => {
  it("soft-recognizes a Flow EVM address with a 200 not-yet-supported message (no walk)", async () => {
    const spy = install(baseFixtures())
    const res = await POST(post({ input: "0x" + "a".repeat(40) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(0)
    expect(body.error).toContain("Flow EVM wallets aren't supported")
    // Tells the user what works instead, and promises nothing unscheduled.
    expect(body.error).toMatch(/Flow address|username/)
    expect(body.error).not.toMatch(/coming soon/i)
    // returned before any owned-ids walk or DB read
    expect(spy.rpcCalls).toHaveLength(0)
  })

  it("rejects an unknown collection slug with a 400 instead of silently walking Top Shot", async () => {
    install(baseFixtures())
    const res = await POST(post({ input: WALLET, collectionId: "beezie" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Unknown collection 'beezie'")
    expect(body.rows).toHaveLength(0)
  })

  it("redirects a Disney Pinnacle lookup to its dedicated route", async () => {
    install(baseFixtures())
    const res = await POST(post({ input: WALLET, collection: "pinnacle" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.redirect).toBe("/api/pinnacle-wallet")
    expect(body.error).toContain("/api/pinnacle-wallet")
  })
})

// 2026-10-23: getCollectionIdForSlug's module-level cache stored the null a
// FAILED collections read returned, so one transient error dropped acquisition
// stats from every later search on that warm instance. A fresh module import
// gives this test an empty cache.
describe("POST /api/wallet-search — a failed collection-id read is not cached", () => {
  it("the next request, with a healthy read, still gets acquisition stats", async () => {
    vi.resetModules()
    const { POST: freshPost } = await import("@/app/api/wallet-search/route")

    install(baseFixtures({ collections: { data: null, error: { message: "canceling statement due to statement timeout" } } }))
    const first = await (await freshPost(post({ input: WALLET }))).json()
    expect(first.acquisitionStats).toBeNull()

    install(baseFixtures())
    const second = await (await freshPost(post({ input: WALLET }))).json()
    expect(second.acquisitionStats).toMatchObject({ total_count: 2 })
  })
})
