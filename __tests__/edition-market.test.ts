import { describe, it, expect, vi, beforeEach } from "vitest"

// Locks in lib/edition-market.ts — the local public/edition-market-data.json
// feed (getEditionMarketRows / getEditionMarketMap). Pins: canonical scope-key
// construction, numeric coercion, alias fan-out (extra map keys → same
// resolved object), source defaulting, note/tag filtering, and error
// resilience (readFile throw, bad JSON, non-array payload all → empty).
// Both @/lib/cache (constant cache key) and the fs promises API are mocked so
// each test controls the on-disk payload with no cross-test leakage.

const readFileMock = vi.fn<() => Promise<string>>()

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}))

vi.mock("fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => readFileMock(),
  },
}))

import { getEditionMarketRows, getEditionMarketMap } from "@/lib/edition-market"

beforeEach(() => {
  readFileMock.mockReset()
})

describe("getEditionMarketRows / error resilience", () => {
  it("returns parsed rows from the JSON file", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([{ editionKey: "8:133", lowAsk: 5 }])
    )
    const rows = await getEditionMarketRows()
    expect(rows).toEqual([{ editionKey: "8:133", lowAsk: 5 }])
  })

  it("readFile throwing yields an empty list, not a throw", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"))
    const rows = await getEditionMarketRows()
    expect(rows).toEqual([])
  })

  it("invalid JSON yields an empty list", async () => {
    readFileMock.mockResolvedValue("{ not valid json")
    const rows = await getEditionMarketRows()
    expect(rows).toEqual([])
  })

  it("non-array JSON payload yields an empty list", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ foo: "bar" }))
    const rows = await getEditionMarketRows()
    expect(rows).toEqual([])
  })
})

describe("getEditionMarketMap — keying & coercion", () => {
  it("builds the canonical scope key and coerces values", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([
        {
          editionKey: "73:2785",
          parallel: "Hexwave",
          lowAsk: "10",
          bestOffer: "",
          lastSale: 42,
        },
      ])
    )
    const map = await getEditionMarketMap()
    const r = map.get("73:2785::Hexwave")!
    expect(r).toBeDefined()
    expect(r.scopeKey).toBe("73:2785::Hexwave")
    expect(r.lowAsk).toBe(10)
    expect(r.bestOffer).toBeNull()
    expect(r.lastSale).toBe(42)
    expect(r.source).toBe("edition-market-file")
  })

  it("no editionKey → set/player composite key with default 'Base' parallel", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([{ setName: "Base Set", playerName: "LeBron", lowAsk: 1 }])
    )
    const map = await getEditionMarketMap()
    expect(map.has("Base Set-LeBron::Base")).toBe(true)
  })

  it("aliases fan out to extra keys pointing at the same resolved object", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([
        {
          editionKey: "1:1",
          parallel: "Base",
          lowAsk: 9,
          aliases: ["alias-a", "  alias-b  ", ""],
          source: "manual",
        },
      ])
    )
    const map = await getEditionMarketMap()
    const canonical = map.get("1:1::Base")!
    expect(canonical.source).toBe("manual")
    // aliases are trimmed; blank alias is skipped
    expect(map.get("alias-a")).toBe(canonical)
    expect(map.get("alias-b")).toBe(canonical)
    expect(map.has("")).toBe(false)
  })

  it("filters non-string notes/tags and defaults empty arrays", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify([
        { editionKey: "2:2", parallel: "Base", notes: ["n", 3, "m"], tags: "nope" },
      ])
    )
    const map = await getEditionMarketMap()
    const r = map.get("2:2::Base")!
    expect(r.notes).toEqual(["n", "m"])
    expect(r.tags).toEqual([])
  })

  it("empty file → empty map", async () => {
    readFileMock.mockResolvedValue(JSON.stringify([]))
    const map = await getEditionMarketMap()
    expect(map.size).toBe(0)
  })
})
