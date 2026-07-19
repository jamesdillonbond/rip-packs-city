import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for GET /api/wallet-packs. Requires ?wallet= → 400
// before any GraphQL work. Success path: a raw 0x address skips username
// resolution and pages the Studio pack-aggregation API — we stub global fetch
// to return one page of Sealed-pack edges and assert the aggregated counts.

vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/wallet-packs/route"

const req = (u: string) => ({ url: u }) as any

afterEach(() => vi.unstubAllGlobals())

describe("GET /api/wallet-packs", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/wallet-packs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })

  it("200s and aggregates owned sealed packs by dist_id + title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({
          data: {
            searchPackNftAggregation: {
              pageInfo: { endCursor: null, hasNextPage: false },
              totalCount: 2,
              edges: [
                { node: { dist_id: { key: "k", value: "d1" }, distribution: { uuid: { value: "u1" }, title: { value: "Pack A" } } } },
                { node: { dist_id: { key: "k", value: "d1" }, distribution: { uuid: { value: "u1" }, title: { value: "Pack A" } } } },
              ],
            },
          },
        }),
      })),
    )
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddress).toBe("0xbd94cade097e50ac")
    expect(body.totalSealedPacks).toBe(2)
    expect(body.owned.d1).toBe(2)
    expect(body.packsByTitle["Pack A"]).toBe(2)
  })
})
