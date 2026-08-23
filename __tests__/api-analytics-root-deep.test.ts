import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/analytics — the per-wallet portfolio rollup behind the collection
// Analytics tab. It aggregates a paginated wallet-moments RPC into tier / series
// / confidence breakdowns, and the two things worth pinning are both HONESTY
// rules rather than arithmetic:
//
//   1. Acquisition history only exists for Top Shot (the TS GraphQL acquisition
//      timeline). For every other collection the route returns `acquisition:
//      null` rather than a row of zeros — a zeroed breakdown would read as
//      "this collector pulled nothing from packs", which is a claim we cannot
//      make. That branch had no test.
//   2. portfolio_clarity_score is HIGH+MEDIUM over total. If an unknown
//      confidence value silently counted as clarity, the score would inflate.
//
// Also pinned: the 10-page pagination stop (a whale over 1,000 moments is the
// only case where page 2 is ever requested) and the series-label map.

const state = vi.hoisted(() => ({
  acq: null as unknown,
  pages: [] as unknown[][],
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  resolveThrows: null as string | null,
  resolvedAddress: "0xbd94cade097e50ac" as string | null,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      if (name === "get_acquisition_stats") return { data: state.acq, error: null }
      if (name === "get_wallet_moments_with_fmv") {
        const page = Number(args.p_offset ?? 0) / 1000
        return { data: [{ moments: state.pages[page] ?? [], total_count: 0 }], error: null }
      }
      return { data: null, error: null }
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (state.resolveThrows) throw new Error(state.resolveThrows)
    return { getUserProfileByUsername: { publicInfo: { flowAddress: state.resolvedAddress } } }
  },
}))

const { GET } = await import("@/app/api/analytics/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const WALLET = "0xbd94cade097e50ac"

const req = (qs: string) => new NextRequest(`https://t/api/analytics${qs}`)

function moment(over: Record<string, unknown> = {}) {
  return { tier: "MOMENT_TIER_COMMON", fmv_usd: 10, is_locked: false, confidence: "HIGH", series_number: 4, ...over }
}

beforeEach(() => {
  state.acq = null
  state.pages = [[]]
  state.rpcCalls = []
  state.resolveThrows = null
  state.resolvedAddress = WALLET
})

describe("GET /api/analytics — guards + wallet resolution", () => {
  it("400s without a wallet and without a resolvable collection", async () => {
    expect((await GET(req(""))).status).toBe(400)
    expect((await GET(req(`?wallet=${WALLET}`))).status).toBe(400)
    const bad = await GET(req(`?wallet=${WALLET}&collection_id=not-a-collection`))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain("collection_id required")
  })

  it("accepts either a slug or a canonical UUID", async () => {
    expect((await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()).collection_id).toBe(TS)
    expect((await (await GET(req(`?wallet=${WALLET}&collection_id=${TS}`))).json()).collection_id).toBe(TS)
    // Whitespace-only is treated as absent, not as a lookup miss.
    expect((await GET(req(`?wallet=${WALLET}&collection_id=%20%20`))).status).toBe(400)
  })

  it("passes an 0x address straight through but resolves a username via GQL", async () => {
    await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))
    expect(state.rpcCalls[0].args.p_wallet).toBe(WALLET)

    state.rpcCalls = []
    state.resolvedAddress = "aaaabbbbccccdddd" // no 0x prefix from upstream
    const body = await (await GET(req("?wallet=@trevor&collection_id=nba-top-shot"))).json()
    expect(body.wallet).toBe("0xaaaabbbbccccdddd")
  })

  it("500s and KEEPS our own domain message when the username cannot be resolved", async () => {
    state.resolvedAddress = null
    const res = await GET(req("?wallet=ghost&collection_id=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("Could not resolve username")

    state.resolveThrows = "topshot gql down"
    expect((await GET(req("?wallet=ghost&collection_id=nba-top-shot"))).status).toBe(500)
  })
})

describe("GET /api/analytics — the acquisition honesty rule", () => {
  it("reports the Top Shot breakdown, ignoring unknown methods", async () => {
    state.acq = [{ breakdown: [{ method: "pack_pull", count: 3 }, { method: "sorcery", count: 9 }], total_moments: 4 }]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    expect(body.acquisition).toEqual({
      pack_pull_count: 3, marketplace_count: 0, challenge_reward_count: 0, gift_count: 0, trade_count: 0, total_tracked: 4,
    })
  })

  it("returns NULL rather than a row of zeros for a non-Top-Shot collection with no tracked history", async () => {
    state.acq = [{ breakdown: [], total_moments: 0 }]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=${ALLDAY}`))).json()
    // A zeroed breakdown would read as "pulled nothing from packs" — a claim we
    // cannot make for a collection with no acquisition source.
    expect(body.acquisition).toBeNull()
  })

  it("still reports a non-Top-Shot breakdown once real history exists", async () => {
    state.acq = [{ breakdown: [{ method: "marketplace", count: 2 }], total_moments: 2 }]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=${ALLDAY}`))).json()
    expect(body.acquisition).toMatchObject({ marketplace_count: 2, total_tracked: 2 })
  })

  it("reports a zeroed Top Shot breakdown (0 is meaningful there) even with no rows", async () => {
    state.acq = null
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    expect(body.acquisition).toMatchObject({ total_tracked: 0, pack_pull_count: 0 })
  })
})

describe("GET /api/analytics — aggregation", () => {
  it("rolls tiers and locked/unlocked FMV, rounding to cents", async () => {
    state.pages = [[
      moment({ tier: "MOMENT_TIER_RARE", fmv_usd: 10.555, is_locked: true }),
      moment({ tier: "MOMENT_TIER_RARE", fmv_usd: 5, is_locked: false }),
      moment({ tier: null, fmv_usd: null }),
    ]]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()

    expect(body.total_moments).toBe(3)
    expect(body.locked).toMatchObject({ locked_count: 1, unlocked_count: 2, locked_fmv: 10.56, unlocked_fmv: 5 })
    // A null tier becomes UNKNOWN rather than being dropped from the rollup.
    expect(body.tiers.map((t: { tier: string }) => t.tier).sort()).toEqual(["RARE", "UNKNOWN"])
    expect(body.total_fmv).toBe(15.56)
  })

  it("labels series from the map, falls back for an unmapped number, and buckets a null as Unknown", async () => {
    state.pages = [[
      moment({ series_number: 0 }), moment({ series_number: 3 }),
      moment({ series_number: 42 }), moment({ series_number: null }),
    ]]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    const labels = body.series.map((s: { label: string }) => s.label)
    // Sorted by seriesNumber, so the null (-1) bucket leads.
    expect(labels).toEqual(["Unknown", "Series 1", "Summer 2021", "Series 42"])
  })

  it("scores clarity as HIGH+MEDIUM over total and files an unknown confidence as NO_DATA", async () => {
    state.pages = [[
      moment({ confidence: "HIGH" }), moment({ confidence: "medium" }),
      moment({ confidence: "LOW" }), moment({ confidence: "SOMETHING_NEW" }),
    ]]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    expect(body.confidence.HIGH).toBe(1)
    expect(body.confidence.MEDIUM).toBe(1) // lower-case is upper-cased first
    // An unrecognised value must NOT inflate clarity.
    expect(body.confidence.NO_DATA).toBe(1)
    expect(body.portfolio_clarity_score).toBe(50)
  })

  it("scores clarity 0 for an empty wallet instead of dividing by zero", async () => {
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    expect(body.total_moments).toBe(0)
    expect(body.portfolio_clarity_score).toBe(0)
  })

  it("pages a whale past the 1,000-row window and stops on the first short page", async () => {
    state.pages = [
      Array.from({ length: 1000 }, () => moment()),
      Array.from({ length: 4 }, () => moment()),
    ]
    const body = await (await GET(req(`?wallet=${WALLET}&collection_id=nba-top-shot`))).json()
    expect(body.total_moments).toBe(1004)
    const momentCalls = state.rpcCalls.filter((c) => c.name === "get_wallet_moments_with_fmv")
    expect(momentCalls).toHaveLength(2) // short page 2 ends the walk
    expect(momentCalls[1].args.p_offset).toBe(1000)
  })

  it("scopes every RPC to the resolved wallet AND collection", async () => {
    await GET(req(`?wallet=${WALLET}&collection_id=${ALLDAY}`))
    for (const call of state.rpcCalls) {
      expect(call.args.p_wallet).toBe(WALLET)
      expect(call.args.p_collection_id).toBe(ALLDAY)
    }
  })
})
