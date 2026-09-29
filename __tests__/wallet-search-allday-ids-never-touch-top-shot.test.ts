import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/api/wallet-search` serves `collection: "nfl-all-day"` by reading the
// wallet's ALL DAY ids — and then ran every one of them through TOP SHOT
// lookups (the Top Shot metadata script, Top Shot GraphQL) and wrote the result
// into the TOP SHOT wallet_moments_cache. A moment id is unique only within a
// collection (#142), so:
//
//   · the Top Shot metadata script answered "no nft" → a nameless
//     `edition_key IS NULL`, set_name "Unknown Set" row in the Top Shot cache;
//   · Top Shot GraphQL, when it answers, returns a DIFFERENT moment that shares
//     the number — a Top Shot player on an All Day row.
//
// Every All Day collection-page load fires this request (limit 50), which is
// why the rows arrived ~50 per wallet. Measured 2026-09-29: 1,681 such Top Shot
// rows across 36 wallets; a chain read of one id per wallet found 33 held in
// the wallet's ALL DAY collection, 1 a genuine Top Shot moment, 2 moved. The
// Cowork diagnosis the same day ("phantom stubs, 40/40 no_nft") read only the
// Top Shot collection, so it saw the absence and not where the moment was.
//
// ⛔ Pinned: an All Day id reaches NO Top Shot upstream and NO Top Shot-keyed
// write. The positive control proves the write spy can see the cache write the
// Top Shot path does make — without it, "no writes" would pass on a harness
// that records nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as number[],
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
      // A Top Shot moment that happens to share the All Day id's number.
      return {
        player: "Damian Lillard", team: "POR", setName: "Base Set", series: "5",
        serial: "5", mint: "15000", playID: "45", setID: "3",
      }
    },
  },
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) => {
    state.gqlCalls.push(vars.id)
    return {
      getMintedMoment: {
        data: {
          flowId: `flow-${vars.id}`, flowSerialNumber: "5", tier: "TIER_COMMON", forSale: false,
          price: null, lastPurchasePrice: "8", isLocked: false, createdAt: "2026-01-01T00:00:00Z",
          badges: [], set: { id: "3", leagues: ["NBA"] }, play: { id: "45", stats: { jerseyNumber: "0" } },
          topshotScore: { score: 100 },
        },
      },
    }
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

const WALLET = "0x6b939a05bfb81e11"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const post = (body: Record<string, unknown>) =>
  new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })

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
    "rpc:get_wallet_acquisition_data": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
  } as Fixtures)
  state.sb = spy.fixture
  return spy
}

// The cache write is fire-and-forget; let it land before reading the spy.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

let spy: ReturnType<typeof install>
beforeEach(() => {
  state.ownedIds = [3345250, 5936304, 10644371]
  state.gqlCalls = []
  state.metaCalls = []
  spy = install()
})

describe("an All Day wallet-search never touches Top Shot", () => {
  it("control: a Top Shot request DOES write the Top Shot cache (the spy can see it)", async () => {
    const res = await POST(post({ input: WALLET, offset: 0, limit: 50 }))
    expect(res.status).toBe(200)
    await settle()
    expect(state.gqlCalls.length).toBe(3)
    expect((spy.writes.wallet_moments_cache ?? []).length).toBeGreaterThan(0)
  })

  it("asks no Top Shot upstream for an All Day id", async () => {
    const res = await POST(post({ input: WALLET, offset: 0, limit: 50, collection: "nfl-all-day" }))
    expect(res.status).toBe(200)
    await settle()
    expect(state.gqlCalls).toEqual([])
    expect(state.metaCalls).toEqual([])
  })

  it("writes nothing into the Top Shot cache, editions or acquisitions", async () => {
    await POST(post({ input: WALLET, offset: 0, limit: 50, collection: "nfl-all-day" }))
    await settle()
    expect(spy.writes.wallet_moments_cache ?? []).toEqual([])
    expect(spy.writes.editions ?? []).toEqual([])
    expect(spy.writes.moment_acquisitions ?? []).toEqual([])
  })

  it("does not put a Top Shot player on an All Day row", async () => {
    const body = await (
      await POST(post({ input: WALLET, offset: 0, limit: 50, collection: "nfl-all-day" }))
    ).json()
    expect(body.summary.totalMoments).toBe(3)
    for (const row of body.rows) {
      expect(row.playerName).not.toBe("Damian Lillard")
      expect(row.editionKey).toBeNull()
      expect(row.enrichFailed).toBe(true)
    }
  })
})
