import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/market-snapshot (POST, no auth).
// Parses body.items and fans out buildMarketSnapshot through getOrSetCache; a
// body.json() throw is caught → 500. We mock @/lib/market-analytics and
// @/lib/cache so no DB is touched. Pins the empty-items happy path (Promise.all
// over [] → results:[], neither mock invoked) and the bad-JSON 500.

vi.mock("@/lib/market-analytics", () => ({
  buildMarketSnapshot: async (item: any) => ({ momentId: item.momentId, snapshot: true }),
}))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, fn: () => Promise<any>) => fn(),
}))

import { POST } from "@/app/api/market-snapshot/route"

const jsonReq = (body: any) => ({ json: async () => body }) as any
const badReq = () =>
  ({
    json: async () => {
      throw new Error("invalid json")
    },
  }) as any

describe("POST /api/market-snapshot", () => {
  it("returns an empty results array for an empty items list", async () => {
    const res = await POST(jsonReq({ items: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })

  it("treats a non-array items field as empty", async () => {
    const res = await POST(jsonReq({}))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([])
  })

  it("builds a snapshot per cleaned item", async () => {
    const res = await POST(
      jsonReq({ items: [{ momentId: "m1", bestAsk: "10", specialSerialTraits: ["JERSEY"] }] })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ momentId: "m1", snapshot: true })
  })

  it("500s when the request body is not valid JSON", async () => {
    const res = await POST(badReq())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBeTruthy()
  })
})
