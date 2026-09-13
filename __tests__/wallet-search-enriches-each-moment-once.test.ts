import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/api/wallet-search` enriches each moment from two independent upstreams —
// Top Shot's GraphQL and a Flow metadata script — with `Promise.all`. That
// rejects on the FIRST failure and discards whatever the sibling returned, so
// the degraded-row branch re-fetched BOTH. Every moment therefore paid TWO
// enrichment round-trips whenever either leg failed.
//
// ⚠ Not a theoretical cost. Measured 2026-09-13, while Top Shot GraphQL was
// answering 530/429 for 100% of moments (200 `failed with 530` occurrences in
// 24 h, every sampled request failing all 24–50 of its moments):
//
//     /api/wallet-search   60 runs   avg 33,559 ms   max 35,505   51 not ok
//
// against cron-job.org's 30 s client cap — which is why `RPC Smoke Concierge
// Daily` had no successful run in retained history. ⭐ The job's NAME misled the
// diagnosis for two days: no concierge probe is implicated, this one route
// exceeds the cap on its own. And on a 429 the doubling also doubled
// `withRetry`'s 2 s sleep, so the waste was wall-clock, not just load.
//
// ⛔ What is pinned is NOT "allSettled is used" — it is that ONE attempt per
// upstream per moment is made, and that the attempt which SUCCEEDED still
// reaches the degraded row. A future rewrite that satisfies both is free to
// drop `allSettled`; one that restores the re-fetch is not.
//
// ⚠ This also says nothing about the 530 itself, which is upstream and not
// fixed by anything here. Halving the load a dead upstream is asked to carry is
// the whole claim.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  gqlById: {} as Record<string, unknown>,
  gqlThrows: null as string | null,
  metaThrows: false,
  gqlCalls: [] as string[],
  metaCalls: [] as string[],
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
      state.metaCalls.push(collected[1])
      if (state.metaThrows) throw new Error("no nft")
      const meta = state.metadataById[collected[1]]
      if (!meta) throw new Error("no nft")
      return meta
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) => {
    state.gqlCalls.push(vars.id)
    if (state.gqlThrows) throw new Error(state.gqlThrows)
    return state.gqlById[vars.id] ?? { getMintedMoment: { data: null } }
  },
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
// The shape production was actually returning, so the pin is on the real error.
const CF_530 = "Top Shot GraphQL failed with 530. Response body: error code: 530"

const post = (body: Record<string, unknown>) =>
  new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })

function momentMeta(serial: string): Record<string, string> {
  return {
    player: "Damian Lillard",
    team: "POR",
    setName: "Base Set",
    series: "5",
    serial,
    mint: "15000",
    playID: "45",
    setID: "3",
  }
}

function momentGql(flowId: string, serial: string) {
  return {
    getMintedMoment: {
      data: {
        flowId,
        flowSerialNumber: serial,
        tier: "TIER_COMMON",
        forSale: false,
        price: null,
        lastPurchasePrice: "8",
        isLocked: false,
        createdAt: "2026-01-01T00:00:00Z",
        badges: [],
        set: { id: "3", leagues: ["NBA"] },
        play: { id: "45", stats: { jerseyNumber: "0" } },
        topshotScore: { score: 100 },
      },
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install() {
  const spy = makeInstrumentedSupabaseFixture({
    collections: { data: { id: TS_UUID }, error: null },
    editions: [
      { data: null, error: null },
      { data: [{ id: "uuid-ed-1", external_id: "3:45" }], error: null },
    ],
    cached_listings: { data: [], error: null },
    fmv_current: { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    moment_acquisitions: { data: null, error: null },
    sales: { data: [], error: null },
    "rpc:get_wallet_acquisition_data": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
  } as Fixtures)
  state.sb = spy.fixture
  return spy
}

const IDS = [101, 102, 103]

beforeEach(() => {
  state.ownedIds = [...IDS]
  state.metadataById = { "101": momentMeta("5"), "102": momentMeta("777"), "103": momentMeta("12") }
  state.gqlById = {
    "101": momentGql("flow-101", "5"),
    "102": momentGql("flow-102", "777"),
    "103": momentGql("flow-103", "12"),
  }
  state.gqlThrows = null
  state.metaThrows = false
  state.gqlCalls = []
  state.metaCalls = []
  install()
})

/** How many times each moment id was asked for, across the whole request. */
const tally = (calls: string[]) => {
  const m: Record<string, number> = {}
  for (const id of calls) m[id] = (m[id] ?? 0) + 1
  return m
}

describe("wallet-search asks each upstream once per moment", () => {
  it("on the happy path, one GraphQL call and one metadata call per moment", async () => {
    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    expect(tally(state.gqlCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
    expect(tally(state.metaCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
  })

  it("⭐ when GraphQL is down, it is still asked ONCE per moment — not twice", async () => {
    // The production case: Top Shot GQL 530 for 100% of moments. The old shape
    // called it again from the degraded branch, doubling the load on a dead
    // upstream and doubling the wall-clock this route spends waiting on it.
    state.gqlThrows = CF_530
    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    expect(tally(state.gqlCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
  })

  it("⭐ and the metadata leg that SUCCEEDED is not re-fetched either", async () => {
    state.gqlThrows = CF_530
    await POST(post({ input: WALLET }))
    expect(tally(state.metaCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
  })

  it("when the Flow metadata script is down instead, GraphQL is not re-fetched", async () => {
    // The mirror case, so the property is not accidentally pinned to one leg.
    state.metaThrows = true
    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    expect(tally(state.gqlCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
    expect(tally(state.metaCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
  })
})

describe("the surviving leg's values still reach the degraded row", () => {
  // ⛔ The counts above are only half the contract. Asking once is trivially
  // satisfiable by throwing the first attempt's results away, which would turn
  // a saving into data loss — the repo's own failure mode. These pin that the
  // ONE attempt is actually used.

  it("GraphQL down: the row still carries the metadata that was read", async () => {
    state.gqlThrows = CF_530
    const body = await (await POST(post({ input: WALLET }))).json()
    const row = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(row).toBeTruthy()
    // Read from the Flow script, which succeeded — NOT the honest-failure copy.
    expect(row.playerName).toBe("Damian Lillard")
    expect(row.setName).toBe("Base Set")
    expect(row.serialNumber).toBe(5)
    // Its edition key resolved from the metadata's own setID:playID.
    expect(row.editionKey).toBe("3:45")
    // ...while the fields only GraphQL could answer stay UNKNOWN, not false/[].
    expect(row.enrichFailed).toBe(true)
    expect(row.isLocked).toBeUndefined()
    expect(row.officialBadges).toBeUndefined()
  })

  it("Flow metadata down: the row still carries the GraphQL flowId that was read", async () => {
    state.metaThrows = true
    const body = await (await POST(post({ input: WALLET }))).json()
    const row = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(row).toBeTruthy()
    expect(row.flowId).toBe("flow-101")
    // No metadata was read, so the row says so rather than naming a player.
    expect(row.playerName).toBe("Unknown (error loading)")
    expect(row.enrichFailed).toBe(true)
  })

  it("both upstreams down: one call each, and the row asserts nothing", async () => {
    state.gqlThrows = CF_530
    state.metaThrows = true
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(tally(state.gqlCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
    expect(tally(state.metaCalls)).toEqual({ "101": 1, "102": 1, "103": 1 })
    const row = body.rows.find((r: { momentId: string }) => r.momentId === "101")
    expect(row.enrichFailed).toBe(true)
    expect(row.isLocked).toBeUndefined()
    expect(row.flowId).toBeNull()
    expect(row.editionKey).toBeNull()
  })
})
