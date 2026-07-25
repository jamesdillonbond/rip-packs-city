import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/profile/market-pulse (the sibling only spot-checks). Per-
// collection floor + index health: an exact-count snapshotsToday, indexedEditions,
// and tier floors from cached_listings, cached 60s. Legs pinned: the known-uuid vs
// unknown-collection count paths, the tier-floor grouping with FANDOM/UNCOMMON/
// ULTIMATE fallbacks, the empty-listings case, a count-query throw → 0 (non-fatal),
// and the fresh-cache short-circuit. Module cache reset per test.

const st = vi.hoisted(() => ({ snapCount: 0, edCount: 0, listings: [] as any[], snapThrow: false }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, gte: () => b, gt: () => b, order: () => b, limit: () => b,
        then: (resolve: any) => {
          if (table === "fmv_snapshots") { if (st.snapThrow) throw new Error("count down"); return resolve({ count: st.snapCount }) }
          if (table === "editions") return resolve({ count: st.edCount })
          if (table === "cached_listings") return resolve({ data: st.listings })
          return resolve({ data: null, count: 0 })
        },
      }
      return b
    },
  },
}))

async function loadGET() {
  vi.resetModules()
  return (await import("@/app/api/profile/market-pulse/route")).GET
}
const get = (qs = "?collectionId=nba-top-shot") => ({ nextUrl: new URL(`https://t/api/profile/market-pulse${qs}`) }) as any

beforeEach(() => {
  st.snapCount = 0; st.edCount = 0; st.listings = []; st.snapThrow = false
})

describe("GET /api/profile/market-pulse", () => {
  it("known collection: exact snapshot count + edition count + tier floors", async () => {
    st.snapCount = 4243; st.edCount = 19000
    st.listings = [
      { tier: "COMMON", ask_price: "5" }, { tier: "COMMON", ask_price: "9" },
      { tier: "RARE", ask_price: "50" }, { tier: "LEGENDARY", ask_price: "500" },
    ]
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.snapshotsToday).toBe(4243) // exact count, not clamped
    expect(body.indexedEditions).toBe(19000)
    expect(body.commonFloor).toBe(5) // lowest of the COMMON asks (sorted asc in-query)
    expect(body.rareFloor).toBe(50)
    expect(body.legendaryFloor).toBe(500)
  })

  it("tier fallbacks: FANDOM→common, UNCOMMON→rare, ULTIMATE→legendary", async () => {
    st.snapCount = 1; st.edCount = 1
    st.listings = [{ tier: "FANDOM", ask_price: "3" }, { tier: "UNCOMMON", ask_price: "30" }, { tier: "ULTIMATE", ask_price: "3000" }]
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.commonFloor).toBe(3)
    expect(body.rareFloor).toBe(30)
    expect(body.legendaryFloor).toBe(3000)
  })

  it("empty listings → all floors null", async () => {
    st.snapCount = 10; st.edCount = 5; st.listings = []
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.commonFloor).toBeNull()
    expect(body.rareFloor).toBeNull()
    expect(body.legendaryFloor).toBeNull()
  })

  it("unknown collection → global count path (no crash)", async () => {
    st.snapCount = 999; st.edCount = 42
    const GET = await loadGET()
    const body = await (await GET(get("?collectionId=bogus-collection"))).json()
    expect(body.collectionId).toBe("bogus-collection")
    // unknown uuid ⇒ both snapshotsToday and indexedEditions read the fmv_snapshots count
    expect(body.snapshotsToday).toBe(999)
    expect(body.indexedEditions).toBe(999)
  })

  it("a snapshot count-query throw is non-fatal (snapshotsToday stays 0)", async () => {
    st.snapThrow = true; st.edCount = 5
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.snapshotsToday).toBe(0)
  })

  it("a fresh cache short-circuits the second call", async () => {
    st.snapCount = 100; st.edCount = 100; st.listings = [{ tier: "COMMON", ask_price: "7" }]
    const GET = await loadGET()
    const first = await (await GET(get())).json()
    // mutate the source; a cached second call must ignore it
    st.listings = [{ tier: "COMMON", ask_price: "1" }]
    const second = await (await GET(get())).json()
    expect(second.commonFloor).toBe(first.commonFloor) // served from cache (7, not 1)
    expect(second.commonFloor).toBe(7)
  })
})
