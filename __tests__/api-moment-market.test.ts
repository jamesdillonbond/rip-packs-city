import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/moment-market (POST). No auth. Fans out to
// topshotGraphql per momentId. Mocks @/lib/topshot so no network I/O happens.
// Pins the empty-momentIds 400 guard, the TopShot-only happy path, and the
// upstream-error → 500.

const state: { moment: any; throwGql: boolean } = { moment: null, throwGql: false }

vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (state.throwGql) throw new Error("gql down")
    return { getMintedMoment: { data: state.moment } }
  },
}))

import { POST } from "@/app/api/moment-market/route"

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.moment = null
  state.throwGql = false
})

describe("POST /api/moment-market", () => {
  it("400s when momentIds is empty", async () => {
    const res = await POST(req({ momentIds: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("momentIds must be a non-empty array.")
  })

  it("400s when momentIds is missing", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it("returns a TopShot-derived quote with bestMarket set when for sale", async () => {
    state.moment = { flowId: "f1", forSale: true, price: 25, tier: "COMMON", badges: [] }
    const res = await POST(req({ momentIds: ["m1"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].momentId).toBe("m1")
    expect(body.results[0].topshotAsk).toBe(25)
    expect(body.results[0].bestAsk).toBe(25)
    expect(body.results[0].bestMarket).toBe("Top Shot")
  })

  it("500s when the upstream GraphQL call throws", async () => {
    state.throwGql = true
    const res = await POST(req({ momentIds: ["m1"] }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("gql down")
  })
})
