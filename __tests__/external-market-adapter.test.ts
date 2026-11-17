import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Locks in lib/external-market-adapter.ts::getExternalEditionMarketMap — the
// optional RPC_EXTERNAL_MARKET_URL feed. Pins: no-URL → empty map, scope-key
// derivation (explicit scopeKey verbatim vs buildEditionScopeKey fallback),
// numeric/count coercion (toNum / toCount) and note/tag string-filtering, the
// non-array-payload guard, and the !ok fetch branch that rejects.
// @/lib/cache is mocked pass-through so fetch is driven per-test with no
// cross-test cache leakage.

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}))

import { getExternalEditionMarketMap } from "@/lib/external-market-adapter"

const OLD_ENV = process.env.RPC_EXTERNAL_MARKET_URL

function stubFetchJson(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => payload }))
  )
}

beforeEach(() => {
  process.env.RPC_EXTERNAL_MARKET_URL = "https://example.test/market.json"
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (OLD_ENV === undefined) delete process.env.RPC_EXTERNAL_MARKET_URL
  else process.env.RPC_EXTERNAL_MARKET_URL = OLD_ENV
})

describe("getExternalEditionMarketMap — no configured URL", () => {
  it("returns an empty map when RPC_EXTERNAL_MARKET_URL is unset", async () => {
    delete process.env.RPC_EXTERNAL_MARKET_URL
    const map = await getExternalEditionMarketMap()
    expect(map.size).toBe(0)
  })

  it("returns an empty map when the URL is blank/whitespace", async () => {
    process.env.RPC_EXTERNAL_MARKET_URL = "   "
    const map = await getExternalEditionMarketMap()
    expect(map.size).toBe(0)
  })
})

describe("getExternalEditionMarketMap — payload guards", () => {
  it("non-array JSON payload → empty map", async () => {
    stubFetchJson({ not: "an array" })
    const map = await getExternalEditionMarketMap()
    expect(map.size).toBe(0)
  })

  it("!ok response rejects with the status message", async () => {
    stubFetchJson([], false, 503)
    await expect(getExternalEditionMarketMap()).rejects.toThrow(
      "External market adapter failed with 503"
    )
  })
})

describe("getExternalEditionMarketMap — scope-key derivation", () => {
  it("uses an explicit trimmed scopeKey verbatim", async () => {
    stubFetchJson([{ scopeKey: "  custom-scope-key  ", lowAsk: 10 }])
    const map = await getExternalEditionMarketMap()
    const row = map.get("custom-scope-key")!
    expect(row).toBeDefined()
    expect(row.scopeKey).toBe("custom-scope-key")
    expect(row.lowAsk).toBe(10)
  })

  it("falls back to buildEditionScopeKey (editionKey + parallel)", async () => {
    stubFetchJson([{ editionKey: "73:2785", parallel: "Hexwave", lowAsk: 5 }])
    const map = await getExternalEditionMarketMap()
    expect(map.has("73:2785::Hexwave")).toBe(true)
  })

  it("no editionKey → set/player composite key with 'Base' parallel default", async () => {
    stubFetchJson([{ setName: "Base Set", playerName: "LeBron", lowAsk: 5 }])
    const map = await getExternalEditionMarketMap()
    expect(map.has("Base Set-LeBron::Base")).toBe(true)
  })
})

describe("getExternalEditionMarketMap — coercion & defaults", () => {
  it("coerces numeric strings, empty→null, and clamps counts", async () => {
    stubFetchJson([
      {
        scopeKey: "k1",
        lowAsk: "12.5",
        bestOffer: "",
        lastSale: "abc",
        askCount: 3.9,
        offerCount: "-2",
        saleCount: "4",
      },
    ])
    const map = await getExternalEditionMarketMap()
    const r = map.get("k1")!
    expect(r.lowAsk).toBe(12.5)
    expect(r.bestOffer).toBeNull()
    expect(r.lastSale).toBeNull() // "abc" → NaN → null
    expect(r.askCount).toBe(3) // floor(3.9)
    expect(r.offerCount).toBe(0) // negative clamped to 0
    expect(r.saleCount).toBe(4)
  })

  it("defaults source and filters non-string / blank notes & tags", async () => {
    stubFetchJson([
      {
        scopeKey: "k2",
        notes: ["keep", "", "  ", 5, "also"],
        tags: "not-an-array",
      },
    ])
    const map = await getExternalEditionMarketMap()
    const r = map.get("k2")!
    expect(r.source).toBe("external-market-json")
    expect(r.notes).toEqual(["keep", "also"])
    expect(r.tags).toEqual([])
  })

  it("preserves an explicit source string", async () => {
    stubFetchJson([{ scopeKey: "k3", source: "flowscan" }])
    const map = await getExternalEditionMarketMap()
    expect(map.get("k3")!.source).toBe("flowscan")
  })
})
