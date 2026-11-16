// 2026-11-15: /api/wallet-search's per-moment Top Shot GraphQL leg goes to a host that has answered
// 530 / Cloudflare 1033 since ~08-30. A dead-host breaker (lib/wallet-search/topshot-gql-breaker.ts)
// skips the leg for GQL_BREAKER_MS after a 5xx/429, so a search stops paying ~4 s to rediscover it.
// The contract pinned here: (1) only host-down errors trip it; (2) it is half-open (it retries after
// the window); (3) on the route, a dead host is asked at most one concurrent wave, every row is still
// built from the chain metadata that WAS read (the same degraded row as before), and the next search
// asks the dead host nothing; (4) a healthy host never trips it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import {
  GQL_BREAKER_MS,
  GQL_BREAKER_REASON,
  guardTopshotGql,
  resetTopshotGqlBreaker,
  topshotGqlBreakerOpen,
  tripsTopshotGqlBreaker,
} from "@/lib/wallet-search/topshot-gql-breaker"

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
    "rpc:get_editions_latest_fmv_wide": { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    moment_acquisitions: { data: null, error: null },
    sales: { data: [], error: null },
    "rpc:get_wallet_acquisition_data_scoped": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
  } as Fixtures)
  state.sb = spy.fixture
  return spy
}

const IDS = Array.from({ length: 20 }, (_, i) => 101 + i)

beforeEach(() => {
  // 2026-11-15: the route's dead-host breaker is module state; a 530 case must not
  // open it for the next case (each case models one fresh request).
  resetTopshotGqlBreaker()
  state.ownedIds = [...IDS]
  state.metadataById = Object.fromEntries(IDS.map((id) => [String(id), momentMeta(String(id - 100))]))
  state.gqlById = Object.fromEntries(IDS.map((id) => [String(id), momentGql(`flow-${id}`, String(id - 100))]))
  state.gqlThrows = null
  state.metaThrows = false
  state.gqlCalls = []
  state.metaCalls = []
  install()
})


afterEach(() => {
  vi.restoreAllMocks()
  resetTopshotGqlBreaker()
})

describe("what trips the breaker", () => {
  it("an HTTP 5xx or 429 from the host trips it", () => {
    expect(tripsTopshotGqlBreaker(new Error(CF_530))).toBe(true)
    expect(tripsTopshotGqlBreaker(new Error("Top Shot GraphQL failed with 502. Response body: x"))).toBe(true)
    expect(tripsTopshotGqlBreaker(new Error("Top Shot GraphQL failed with 429. Response body: <title>Too Many Requests"))).toBe(true)
  })
  it("a GraphQL error body, a 4xx or an unrelated error does not", () => {
    expect(tripsTopshotGqlBreaker(new Error("moment not found"))).toBe(false)
    expect(tripsTopshotGqlBreaker(new Error("Top Shot GraphQL failed with 404. Response body: x"))).toBe(false)
    expect(tripsTopshotGqlBreaker(new Error("no nft"))).toBe(false)
  })
})

describe("guardTopshotGql", () => {
  it("opens after a host-down error, skips calls while open, and retries once the window passes", async () => {
    const t0 = 1_800_000_000_000
    const now = vi.spyOn(Date, "now").mockReturnValue(t0)
    const call = vi.fn(async () => { throw new Error(CF_530) })
    await expect(guardTopshotGql(call)).rejects.toThrow("530")
    expect(topshotGqlBreakerOpen(t0 + 1)).toBe(true)
    await expect(guardTopshotGql(call)).rejects.toThrow(GQL_BREAKER_REASON)
    expect(call).toHaveBeenCalledTimes(1)
    now.mockReturnValue(t0 + GQL_BREAKER_MS + 1)
    const ok = vi.fn(async () => "revived")
    await expect(guardTopshotGql(ok)).resolves.toBe("revived")
    expect(ok).toHaveBeenCalledTimes(1)
  })
  it("a success or a non-host error never opens it", async () => {
    await guardTopshotGql(async () => 1)
    await expect(guardTopshotGql(async () => { throw new Error("moment not found") })).rejects.toThrow()
    expect(topshotGqlBreakerOpen()).toBe(false)
  })
})

describe("the route under a dead host", () => {
  it("asks the dead host at most one concurrent wave, still builds every row from chain metadata, then asks nothing", async () => {
    state.gqlThrows = CF_530
    const body = await (await POST(post({ input: WALLET, limit: 20 }))).json()
    const first = state.gqlCalls.length
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThanOrEqual(8)
    // every moment's chain metadata was still read once, and every returned row carries it
    expect(state.metaCalls.length).toBe(body.rows.length)
    for (const row of body.rows) {
      expect(row.playerName).toBe("Damian Lillard")
      expect(row.enrichFailed).toBe(true)
      expect(row.isLocked).toBeUndefined()
    }
    // the next search does not ask the dead host at all
    state.gqlCalls = []
    await POST(post({ input: WALLET, limit: 20 }))
    expect(state.gqlCalls).toEqual([])
  })

  it("a healthy host is asked for every moment and never trips the breaker", async () => {
    const body = await (await POST(post({ input: WALLET, limit: 20 }))).json()
    expect(state.gqlCalls.length).toBe(body.rows.length)
    expect(topshotGqlBreakerOpen()).toBe(false)
  })
})
