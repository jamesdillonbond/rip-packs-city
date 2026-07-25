import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of GET /api/panini/listings (the sibling test only pins the empty
// shape). This synchronous route fetches OpenSea listings + a CoinGecko ETH/USD
// price, enriches the first 20 with NFT metadata (normalized traits), computes the
// floor, and caches for 60s — with a stale-cache fallback on error. Legs pinned:
// the listings-fetch failure → 502 (no cache), the happy shaping (price/seller/
// buyUrl/listedAt/traits/floor), the ETH/USD-unavailable branch, the NFT-enrich
// failure tolerance, the fresh-cache short-circuit, and the stale-cache fallback.
// The module-level cache is reset per test via vi.resetModules.

let fetchImpl: (url: string) => any
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => fetchImpl(url)))
}
async function loadGET() {
  vi.resetModules()
  return (await import("@/app/api/panini/listings/route")).GET
}
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
const notOk = (status: number) => ({ ok: false, status, json: async () => ({}) })

const order = (over: any = {}) => ({
  order_hash: "0xhash1",
  price: { current: { value: "1000000000000000000", decimals: 18 } }, // 1 ETH
  maker: { address: "0xseller" },
  protocol_data: { parameters: { offer: [{ token: "0xtoken", identifierOrCriteria: "42" }] } },
  listing_time: 1_700_000_000,
  ...over,
})

// A router: OpenSea listings, CoinGecko price, OpenSea NFT metadata.
function router(opts: {
  listings?: any
  listingsStatus?: number
  cg?: number | null
  nft?: any
  nftThrows?: boolean
}) {
  return (url: string) => {
    if (url.includes("/listings/collection/")) {
      return opts.listingsStatus && opts.listingsStatus !== 200 ? notOk(opts.listingsStatus) : ok({ listings: opts.listings ?? [] })
    }
    if (url.includes("coingecko")) {
      return opts.cg == null ? notOk(500) : ok({ ethereum: { usd: opts.cg } })
    }
    if (url.includes("/nfts/")) {
      if (opts.nftThrows) throw new Error("nft down")
      return opts.nft ? ok({ nft: opts.nft }) : notOk(404)
    }
    return notOk(404)
  }
}

beforeEach(() => { installFetch() })
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/panini/listings", () => {
  it("listings fetch failure with no cache → 502", async () => {
    fetchImpl = router({ listingsStatus: 503 })
    const GET = await loadGET()
    const res = await GET()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("Failed to fetch listings")
  })

  it("happy path: shapes price/seller/buyUrl/traits, computes USD + floor", async () => {
    fetchImpl = router({
      listings: [order()],
      cg: 3000,
      nft: { name: "Messi #5", image_url: "img", traits: [{ trait_type: "Player", value: "Messi" }, { trait_type: "Ignored", value: "x" }] },
    })
    const GET = await loadGET()
    const body = await (await GET()).json()
    expect(body.count).toBe(1)
    const l = body.listings[0]
    expect(l.price_eth).toBe(1)
    expect(l.price_usd).toBe(3000)
    expect(l.seller).toBe("0xseller")
    expect(l.buy_url).toBe("https://opensea.io/assets/ethereum/0xtoken/42")
    expect(l.name).toBe("Messi #5")
    expect(l.traits).toEqual({ Player: "Messi" }) // unknown trait dropped by normalizeTrait
    expect(body.floor_eth).toBe(1)
  })

  it("ETH/USD unavailable → price_usd null (non-critical)", async () => {
    fetchImpl = router({ listings: [order()], cg: null, nft: { name: "n", traits: [] } })
    const GET = await loadGET()
    const body = await (await GET()).json()
    expect(body.listings[0].price_usd).toBeNull()
  })

  it("an order with no price → priceEth 0 and it does not set the floor", async () => {
    fetchImpl = router({ listings: [order({ price: undefined })], cg: 3000, nft: { name: "n", traits: [] } })
    const GET = await loadGET()
    const body = await (await GET()).json()
    expect(body.listings[0].price_eth).toBe(0)
    expect(body.floor_eth).toBeNull() // no positive price ⇒ minPrice stayed Infinity
  })

  it("missing token/id → buy_url falls back to the collection page", async () => {
    fetchImpl = router({
      listings: [order({ protocol_data: { parameters: { offer: [] } } })],
      cg: 3000,
    })
    const GET = await loadGET()
    const body = await (await GET()).json()
    expect(body.listings[0].buy_url).toBe("https://opensea.io/collection/paniniblockchain")
  })

  it("NFT-metadata fetch throwing is tolerated (listing keeps null name/image)", async () => {
    fetchImpl = router({ listings: [order()], cg: 3000, nftThrows: true })
    const GET = await loadGET()
    const body = await (await GET()).json()
    expect(body.listings[0].name).toBeNull()
    expect(body.listings[0].image_url).toBeNull()
  })

  it("a fresh cache short-circuits the second call (no new fetch)", async () => {
    fetchImpl = router({ listings: [order()], cg: 3000, nft: { name: "n", traits: [] } })
    const GET = await loadGET()
    await GET()
    const callsAfterFirst = (globalThis.fetch as any).mock.calls.length
    await GET() // within 60s TTL → served from cache
    expect((globalThis.fetch as any).mock.calls.length).toBe(callsAfterFirst)
  })

  it("on a later error the STALE cache is served instead of 502", async () => {
    // First call populates cache…
    fetchImpl = router({ listings: [order()], cg: 3000, nft: { name: "cached", traits: [] } })
    const GET = await loadGET()
    await GET()
    // …expire the cache by advancing time, then fail the refresh.
    const realNow = Date.now
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 120_000)
    fetchImpl = router({ listingsStatus: 500 })
    const res = await GET()
    expect(res.status).toBe(200) // stale cache, not 502
    expect((await res.json()).listings[0].name).toBe("cached")
    ;(Date.now as any).mockRestore()
  })
})
