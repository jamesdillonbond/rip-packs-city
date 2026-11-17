import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-truth (POST). No auth / no param 400 —
// non-array body.rows coerces to []. Mocks the compute seam
// (@/lib/market-sources buildUnifiedEditionMarketMap + @/lib/market-compute
// computeFmv) so no network I/O happens. Pins the empty-rows path, the
// per-row enrich passthrough, and the catch → 500.

const state: { map: Map<string, any>; throwBuild: boolean } = {
  map: new Map(),
  throwBuild: false,
}

vi.mock("@/lib/market-sources", () => ({
  buildUnifiedEditionMarketMap: async () => {
    if (state.throwBuild) throw new Error("sources down")
    return state.map
  },
}))
vi.mock("@/lib/market-compute", () => ({
  computeFmv: (input: any) => ({ momentId: input.momentId, computed: true }),
}))

import { POST } from "@/app/api/market-truth/route"

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.map = new Map()
  state.throwBuild = false
})

describe("POST /api/market-truth", () => {
  it("returns an empty rows array when body.rows is not an array", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("enriches each input row through computeFmv", async () => {
    const res = await POST(req({ rows: [{ momentId: "42" }, { momentId: "43" }] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0]).toMatchObject({ momentId: "42", computed: true })
  })

  it("500s when the market-source lookup throws", async () => {
    state.throwBuild = true
    const res = await POST(req({ rows: [{ momentId: "1" }] }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain("sources down")
    // `rows` is deliberately ABSENT on the failure path now. It used to ship as
    // [] beside the 500, which lets a caller that skips res.ok render "no
    // market data" — a claim about the market — out of an internal error.
    expect(body.rows).toBeUndefined()
  })
})
