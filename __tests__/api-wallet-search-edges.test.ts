import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// The wallet-search legs the sibling deep test doesn't reach — all of them
// "quietly wrong" failure modes rather than loud ones:
//
//   - the LEAGUE FILTER, which intersects the on-chain id set with wmc rows.
//     It pages with .range() because PostgREST clamps a bare .limit() at 1,000
//     and a whale can own more than that in one league — a clamp here hides
//     moments the collector actually owns. On a page error the filter must be
//     abandoned entirely (show everything) rather than render a false-empty
//     wallet from a transient DB blip.
//   - the FMV play_id_onchain FALLBACK for numeric edition keys that don't
//     match a UUID-format editions.external_id, including its re-application of
//     the same >$10K sanity ceiling as the primary lookup (a fallback that
//     skipped the ceiling would be a hole straight through it).
//   - the SALES-BACKFILL second pass: moments whose GQL carried no
//     lastPurchasePrice get cost basis from the most recent sale of that
//     nft_id, written as source=sales_backfill and never clobbering an
//     existing row (ignoreDuplicates).
//   - the AllDay owned-ids path, the non-Top-Shot collection dispatches, the
//     acquisition-stats arms, and the request-schema 400s.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  gqlById: {} as Record<string, unknown>,
}))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: (_key: string, _ttl: number, fn: () => unknown) => fn(),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const meta = state.metadataById[collected[1]]
      if (!meta) throw new Error("no nft")
      return meta
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) =>
    state.gqlById[vars.id] ?? { getMintedMoment: { data: null } },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => ({ found: false }),
}))

const { POST } = await import("@/app/api/wallet-search/route")

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const post = (body: Record<string, unknown>) =>
  new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })

function momentMeta(serial: string): Record<string, string> {
  return { player: "Damian Lillard", team: "POR", setName: "Base Set", series: "5", serial, mint: "15000", playID: "45", setID: "3" }
}

function momentGql(flowId: string, serial: string, over: Record<string, unknown> = {}) {
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
        badges: [],
        set: { id: "3", leagues: ["NBA"] },
        play: { id: "45", stats: { jerseyNumber: "0" } },
        topshotScore: { score: 100 },
        ...over,
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

/** editions reads in order: [0] batch upsert ack, [1] key resolve, [2] the
 *  play_id_onchain fallback, [3+] the wmc canonical-key lookup. */
function baseFixtures(over: Fixtures = {}): Fixtures {
  return {
    collections: { data: { id: TS_UUID }, error: null },
    editions: [
      { data: null, error: null },
      { data: [{ id: "uuid-ed-1", external_id: "3:45" }], error: null },
    ],
    cached_listings: { data: [], error: null },
    fmv_snapshots: { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    moment_acquisitions: { data: null, error: null },
    sales: { data: [], error: null },
    "rpc:get_wallet_acquisition_data": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
    ...over,
  }
}

/** Let the route's fire-and-forget tails run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.ownedIds = [101, 102]
  state.metadataById = { "101": momentMeta("5"), "102": momentMeta("777") }
  state.gqlById = { "101": momentGql("flow-101", "5"), "102": momentGql("flow-102", "777") }
})

describe("wallet-search — request dispatch", () => {
  it("400s a body with no input and a body that fails the schema", async () => {
    install(baseFixtures())
    expect((await POST(post({}))).status).toBe(400)
    const res = await POST(post({ input: WALLET, limit: -5 }))
    expect(res.status).toBe(400)
    expect((await res.json()).rows).toEqual([])
  })

  it("redirects UFC to its own scan route and answers Golazos with a graceful 200", async () => {
    install(baseFixtures())
    const ufc = await POST(post({ input: WALLET, collection: "ufc" }))
    expect(ufc.status).toBe(400)
    expect((await ufc.json()).redirect).toBe("/api/ufc-wallet-scan")

    const gol = await POST(post({ input: WALLET, collection: "laliga-golazos" }))
    expect(gol.status).toBe(200)
    const body = await gol.json()
    expect(body.rows).toEqual([])
    expect(body.error).toContain("coming soon")
  })

  it("walks the AllDay collection through its own owned-ids script", async () => {
    install(baseFixtures())
    const res = await POST(post({ input: WALLET, collection: "nfl-all-day" }))
    expect(res.status).toBe(200)
    expect((await res.json()).summary.totalMoments).toBe(2)
  })
})

describe("wallet-search — league filter", () => {
  it("intersects the on-chain ids with the wmc league rows", async () => {
    install(baseFixtures({ wallet_moments_cache: { data: [{ moment_id: "101" }], error: null } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows.map((r: { momentId: string }) => r.momentId)).toEqual(["101"])
  })

  it("pages past the PostgREST 1000-row clamp instead of truncating the allowed set", async () => {
    // A full first page forces a second .range() window; without paging the
    // second page's moment would be filtered out of a wallet that owns it.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ moment_id: String(900000 + i) }))
    const spy = install(
      baseFixtures({
        wallet_moments_cache: [
          { data: page1, error: null },
          { data: [{ moment_id: "102" }], error: null },
          { data: [], error: null },
        ],
      }),
    )
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows[0].momentId).toBe("102")
    expect(spy).toBeTruthy()
  })

  it("abandons the filter on a page error rather than showing a false-empty wallet", async () => {
    install(baseFixtures({ wallet_moments_cache: { data: null, error: { message: "wmc timeout" } } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(2) // unfiltered
  })
})

describe("wallet-search — FMV fallback + ceiling", () => {
  it("resolves FMV through play_id_onchain when the numeric edition key does not match", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null }, // batch upsert
          { data: [], error: null }, // key resolve finds nothing
          { data: [{ id: "uuid-fb", play_id_onchain: 45 }], error: null }, // fallback
        ],
        fmv_snapshots: {
          data: [{ edition_id: "uuid-fb", fmv_usd: 33.25, confidence: "MEDIUM", sales_count_30d: 2, computed_at: "2026-07-20T00:00:00Z" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBe(33.25)
    expect(body.rows[0].marketConfidence).toBe("medium")
  })

  it("re-applies the >$10K ceiling on the fallback path, so it is not a hole through the guard", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: [], error: null },
          { data: [{ id: "uuid-fb", play_id_onchain: 45 }], error: null },
        ],
        fmv_snapshots: {
          // Over the ceiling on two sales -> discarded, exactly as the primary
          // lookup would discard it.
          data: [{ edition_id: "uuid-fb", fmv_usd: 900000, confidence: "HIGH", sales_count_30d: 2, computed_at: "2026-07-20T00:00:00Z" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBeNull()
  })

  it("keeps the wallet alive when the fallback lookup throws", async () => {
    const spy = makeInstrumentedSupabaseFixture(baseFixtures({ editions: [{ data: null, error: null }, { data: [], error: null }] }))
    const baseFrom = (spy.fixture as { from: (t: string) => unknown }).from.bind(spy.fixture)
    let editionsReads = 0
    ;(spy.fixture as { from: (t: string) => unknown }).from = (t: string) => {
      if (t !== "editions" || ++editionsReads < 3) return baseFrom(t)
      const b: unknown = new Proxy({}, {
        get: (_x, prop) => {
          if (prop === "then") {
            return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.reject(new Error("fallback read exploded")).then(onF, onR)
          }
          return () => b
        },
      })
      return b
    }
    state.sb = spy.fixture

    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(2)
  })
})

describe("wallet-search — cost-basis tails", () => {
  it("backfills cost basis from the most recent sale when GQL carried no purchase price", async () => {
    state.gqlById = {
      "101": momentGql("flow-101", "5", { lastPurchasePrice: "0" }),
      "102": momentGql("flow-102", "777", { lastPurchasePrice: "0" }),
    }
    const spy = install(
      baseFixtures({
        sales: {
          data: [
            { nft_id: "101", price_usd: 14.5, sold_at: "2026-06-01T00:00:00Z", seller_address: "0xseller", transaction_hash: "0xtx" },
            // An older sale of the same moment must lose to the newest one.
            { nft_id: "101", price_usd: 99, sold_at: "2025-01-01T00:00:00Z", seller_address: "0xold", transaction_hash: "0xold" },
          ],
          error: null,
        },
      }),
    )

    await POST(post({ input: WALLET }))
    await flush()

    const backfill = (spy.writes.moment_acquisitions ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
      .filter((r) => r.source === "sales_backfill")
    expect(backfill).toHaveLength(1)
    expect(backfill[0]).toMatchObject({
      nft_id: "101",
      wallet: WALLET,
      buy_price: 14.5,
      seller_address: "0xseller",
      transaction_hash: "0xtx",
    })
  })

  it("writes nothing when there are no sales for the unpriced moments", async () => {
    state.gqlById = { "101": momentGql("flow-101", "5", { lastPurchasePrice: "0" }) }
    state.ownedIds = [101]
    state.metadataById = { "101": momentMeta("5") }
    const spy = install(baseFixtures({ sales: { data: [], error: null } }))

    await POST(post({ input: WALLET }))
    await flush()

    const backfill = (spy.writes.moment_acquisitions ?? [])
      .flatMap((w) => w.rows)
      .filter((r) => r.source === "sales_backfill")
    expect(backfill).toHaveLength(0)
  })

  it("reports acquisition stats from the RPC and degrades to null when it errors", async () => {
    install(
      baseFixtures({
        "rpc:get_acquisition_stats": {
          data: [{ breakdown: [{ method: "pack_pull", count: 3 }, { method: "not_a_method", count: 9 }], total_moments: 4, total_spent: 12, locked_count: 1 }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.acquisitionStats).toMatchObject({
      pack_pull_count: 3,
      marketplace_count: 0, // an unknown method is ignored, not counted
      total_count: 4,
      locked_count: 1,
      total_spent: 12,
    })

    install(baseFixtures({ "rpc:get_acquisition_stats": { data: null, error: { message: "stats down" } } }))
    const errBody = await (await POST(post({ input: WALLET }))).json()
    expect(errBody.acquisitionStats).toBeNull()
  })
})
