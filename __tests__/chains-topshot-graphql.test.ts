// Locks in lib/chains/flow/topshot-graphql.ts — the Top Shot marketplace
// GraphQL client. Pins: parseEditionKey (colon/scope-suffix parsing + null
// guards), fetchEditionStats (dedupe, per-set grouping, single-vs-multi play
// variable selection, node→stats mapping, missing-edition null fill),
// fetchRecentSales (parse guard + node→row mapping), fetchEditionMarketMap
// (hasData note/tag branches), and the gqlRequest error branches (!ok,
// GraphQL errors array, AbortError timeout, thrown fetch). Global fetch is
// stubbed per test; no real network is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  parseEditionKey,
  fetchEditionStats,
  fetchRecentSales,
  fetchEditionMarketMap,
} from "@/lib/chains/flow/topshot-graphql"

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("parseEditionKey", () => {
  it("parses a plain setID:playID key", () => {
    expect(parseEditionKey("8:133")).toEqual({ setID: "8", playID: "133" })
  })

  it("strips the scope-key suffix before parsing", () => {
    expect(parseEditionKey("8:133::Base")).toEqual({ setID: "8", playID: "133" })
    expect(parseEditionKey("8:133::/99")).toEqual({ setID: "8", playID: "133" })
  })

  it("trims whitespace around components", () => {
    expect(parseEditionKey("  8 : 133  ")).toEqual({ setID: "8", playID: "133" })
  })

  it("returns null for a single-part key", () => {
    expect(parseEditionKey("133")).toBeNull()
  })

  it("returns null when a component is empty", () => {
    expect(parseEditionKey("8:")).toBeNull()
    expect(parseEditionKey(":133")).toBeNull()
  })

  it("returns null for a three-colon-part key", () => {
    expect(parseEditionKey("8:133:9")).toBeNull()
  })
})

describe("fetchEditionStats", () => {
  it("returns an empty map for empty input", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const out = await fetchEditionStats([])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns an empty map when no keys are parseable (and never fetches)", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const out = await fetchEditionStats(["nope", "also-bad"])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("maps stats back to the original edition key on the happy path", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          searchEditions: {
            data: [
              {
                set: { id: "8" },
                play: { id: "133" },
                stats: { lowestAsk: 5, averagePrice: 7.5, totalSales: 42 },
                setPlay: { circulationCount: 100 },
              },
            ],
          },
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.get("8:133")).toEqual({
      editionKey: "8:133",
      lowestAsk: 5,
      averagePrice: 7.5,
      salesCount: 42,
      listingCount: 0,
    })
  })

  it("passes the playID when a set has exactly one play", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { searchEditions: { data: [] } } })
    )
    vi.stubGlobal("fetch", fetchMock)

    await fetchEditionStats(["8:133"])
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.variables.setID).toBe("8")
    expect(body.variables.playID).toBe("133")
    expect(body.variables.first).toBe(250)
  })

  it("omits the playID when a set has multiple plays and dedupes keys", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { searchEditions: { data: [] } } })
    )
    vi.stubGlobal("fetch", fetchMock)

    // duplicate 8:133 is deduped; 8:133 + 8:200 share set 8 → one request, no playID
    await fetchEditionStats(["8:133", "8:133", "8:200"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.variables.setID).toBe("8")
    expect(body.variables.playID).toBeUndefined()
  })

  it("fills nulls for an edition missing from the response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { searchEditions: { data: [] } } })
    )
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.get("8:133")).toEqual({
      editionKey: "8:133",
      lowestAsk: null,
      averagePrice: null,
      salesCount: 0,
      listingCount: 0,
    })
  })

  it("fills nulls when the HTTP response is not ok", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 429))
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.get("8:133")?.lowestAsk).toBeNull()
    expect(out.get("8:133")?.salesCount).toBe(0)
  })

  it("still fills the map when the payload carries a GraphQL errors array", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "boom" }], data: { searchEditions: { data: [] } } })
    )
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.has("8:133")).toBe(true)
  })

  it("fills nulls when the fetch throws an AbortError (timeout)", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("aborted")
      e.name = "AbortError"
      throw e
    })
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.get("8:133")?.lowestAsk).toBeNull()
  })

  it("fills nulls when the fetch throws a generic error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down")
    })
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionStats(["8:133"])
    expect(out.get("8:133")?.averagePrice).toBeNull()
  })
})

describe("fetchRecentSales", () => {
  it("returns an empty array for an unparseable key without fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchRecentSales("bad-key")).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("maps transaction nodes to recent-sale rows", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          searchMarketplaceTransactions: {
            data: [
              {
                price: 12,
                transactionDate: "2026-07-01T00:00:00Z",
                moment: {
                  flowSerialNumber: 7,
                  badges: [{ description: "Rookie" }, { description: "" }],
                },
              },
            ],
          },
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const rows = await fetchRecentSales("8:133", 5)
    expect(rows).toEqual([
      {
        editionKey: "8:133",
        serialNumber: 7,
        price: 12,
        soldAt: "2026-07-01T00:00:00Z",
        badges: ["Rookie"], // empty description filtered out
      },
    ])
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.variables.first).toBe(5)
  })

  it("returns an empty array when the response has no transaction data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchRecentSales("8:133")).toEqual([])
  })
})

describe("fetchEditionMarketMap", () => {
  it("emits live tags and no notes when data is present", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          searchEditions: {
            data: [
              {
                set: { id: "8" },
                play: { id: "133" },
                stats: { lowestAsk: 5, averagePrice: 6, totalSales: 3 },
                setPlay: { circulationCount: 1 },
              },
            ],
          },
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionMarketMap(["8:133"])
    const row = out.get("8:133")!
    expect(row.lowAsk).toBe(5)
    expect(row.lastSale).toBe(6)
    expect(row.saleCount).toBe(3)
    expect(row.source).toBe("topshot-graphql")
    expect(row.notes).toEqual([])
    expect(row.tags).toEqual(["graphql", "live"])
  })

  it("emits a no-data note and tag when the edition has no stats", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { searchEditions: { data: [] } } })
    )
    vi.stubGlobal("fetch", fetchMock)

    const out = await fetchEditionMarketMap(["8:133"])
    const row = out.get("8:133")!
    expect(row.notes).toEqual(["No market data found for this edition"])
    expect(row.tags).toEqual(["graphql", "no-data"])
  })
})
