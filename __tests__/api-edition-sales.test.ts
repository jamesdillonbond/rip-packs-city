import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/edition-sales. No auth gate. Mocks
// @/lib/topshot-graphql (parseEditionKey + fetchEditionStats) so no upstream GQL
// is hit. Pins: empty editionKeys short-circuit, the non-nba
// "collection-not-supported" branch, the Top Shot happy path, and the
// invalid-JSON → 500 catch.

vi.mock("@/lib/topshot-graphql", () => ({
  parseEditionKey: (k: string) => (/^\d+:\d+$/.test(k) ? { setID: 1, playID: 1 } : null),
  fetchEditionStats: async (keys: string[]) =>
    new Map(keys.map((k) => [k, { lowestAsk: 5, averagePrice: 6, salesCount: 3, listingCount: 2 }])),
}))

import { POST } from "@/app/api/edition-sales/route"

function req(body: any, badJson = false): any {
  return { json: async () => { if (badJson) throw new Error("bad json"); return body } }
}

describe("POST /api/edition-sales", () => {
  it("returns an empty result set when no editionKeys are supplied", async () => {
    const res = await POST(req({ editionKeys: [] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([])
    expect(body.collectionId).toBe("nba-top-shot")
  })

  it("returns collection-not-supported rows for non-Top-Shot collections", async () => {
    const res = await POST(req({ collectionId: "nfl-all-day", editionKeys: ["1:2"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collectionId).toBe("nfl-all-day")
    expect(body.results[0].source).toBe("collection-not-supported")
    expect(body.results[0].parsed).toBe(false)
  })

  it("returns parsed Top Shot GraphQL stats for parseable keys", async () => {
    const res = await POST(req({ collectionId: "nba-top-shot", editionKeys: ["84:2892", "junk"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = body.results.find((r: any) => r.editionKey === "84:2892")
    expect(parsed.parsed).toBe(true)
    expect(parsed.source).toBe("topshot-graphql")
    expect(parsed.lowestAsk).toBe(5)
    const bad = body.results.find((r: any) => r.editionKey === "junk")
    expect(bad.source).toBe("unparseable")
  })

  it("500s when the request body is invalid JSON", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(500)
  })
})
