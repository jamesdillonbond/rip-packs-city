import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/sniper-feed — #207 on the Sniper (2026-10-22). The Top Shot pool, the
// All Day RPC and the Golazos RPC match the player with an accent-SENSITIVE ilike:
// live, "doncic" answered 0 deals and "Dončić" 96. A search that matched NOTHING
// (and did not fail) is retried once with the single catalog name it matches
// accent-blind, and the response SAYS so (playerResolved).

const st = vi.hoisted(() => ({
  byPlayer: {} as Record<string, any>,
  keys: [] as string[],
  resolve: vi.fn(async (_c: string, _t: string, _caller: string): Promise<string | null> => null),
}))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (key: string) => {
    st.keys.push(key)
    const player = JSON.parse(key.slice("sniper-feed:".length)).player ?? ""
    return st.byPlayer[player] ?? feed([])
  },
  deleteCache: () => {},
}))
vi.mock("@/lib/market/catalog-player", () => ({
  CATALOG_PLAYER_COLLECTIONS: new Set([
    "95f28a17-224a-4025-96ad-adf8a4c63bfd", // Top Shot
    "dee28451-5d62-409e-a1ad-a83f763ac070", // All Day
    "06248cc4-b85f-47cd-af67-1855d14acd75", // Golazos
  ]),
  resolveCatalogPlayer: st.resolve,
}))

import { GET } from "@/app/api/sniper-feed/route"

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const deal = (playerName: string): any => ({ editionKey: "1:2", intEditionKey: "1:2", playerName, paymentToken: "FLOW" })
function feed(deals: any[], sourcesFailed: string[] = []): any {
  return { count: deals.length, tsCount: deals.length, flowtyCount: 0, lastRefreshed: "2026-10-22T00:00:00.000Z", deals, sourcesFailed }
}

beforeEach(() => {
  st.byPlayer = {}
  st.keys = []
  st.resolve.mockReset()
  st.resolve.mockResolvedValue(null)
})

describe("GET /api/sniper-feed — an accent-only player miss", () => {
  it("retries with the catalog spelling and reports the swap", async () => {
    st.byPlayer = { "Luka Dončić": feed([deal("Luka Dončić"), deal("Luka Dončić")]) }
    st.resolve.mockResolvedValue("Luka Dončić")
    const body = await (await GET(get("?collection=nba-top-shot&player=doncic"))).json()
    expect(body.count).toBe(2)
    expect(body.deals.map((d: any) => d.playerName)).toEqual(["Luka Dončić", "Luka Dončić"])
    expect(body.playerResolved).toEqual({ from: "doncic", to: "Luka Dončić" })
    expect(st.resolve).toHaveBeenCalledWith("95f28a17-224a-4025-96ad-adf8a4c63bfd", "doncic", "api/sniper-feed")
  })

  it("a search that matched is untouched — no catalog read, no swap", async () => {
    st.byPlayer = { "curry": feed([deal("Stephen Curry")]) }
    const body = await (await GET(get("?collection=nba-top-shot&player=curry"))).json()
    expect(body.count).toBe(1)
    expect(body.playerResolved).toBeUndefined()
    expect(st.resolve).not.toHaveBeenCalled()
  })

  it("a FAILED read is never retried as if it were empty", async () => {
    st.byPlayer = { "doncic": feed([], ["ts-pool"]) }
    st.resolve.mockResolvedValue("Luka Dončić")
    const body = await (await GET(get("?collection=nba-top-shot&player=doncic"))).json()
    expect(body.degraded).toBe(true)
    expect(body.playerResolved).toBeUndefined()
    expect(st.resolve).not.toHaveBeenCalled()
  })

  it("no single candidate, or a retry that also finds nothing: the empty answer stands, unlabelled", async () => {
    const none = await (await GET(get("?collection=nba-top-shot&player=zzz"))).json()
    expect(none.count).toBe(0)
    expect(none.playerResolved).toBeUndefined()
    st.resolve.mockResolvedValue("Luka Dončić")
    const stillEmpty = await (await GET(get("?collection=nba-top-shot&player=doncic"))).json()
    expect(stillEmpty.count).toBe(0)
    expect(stillEmpty.playerResolved).toBeUndefined()
  })

  it("covers All Day and Golazos; Pinnacle (already accent-blind in memory) is not resolved", async () => {
    st.byPlayer = { "Vinícius Júnior": feed([deal("Vinícius Júnior")]) }
    st.resolve.mockResolvedValue("Vinícius Júnior")
    const gz = await (await GET(get("?collection=laliga-golazos&player=vinicius"))).json()
    expect(gz.playerResolved).toEqual({ from: "vinicius", to: "Vinícius Júnior" })
    st.resolve.mockClear()
    await GET(get("?collection=disney-pinnacle&player=stitch"))
    expect(st.resolve).not.toHaveBeenCalled()
  })
})
