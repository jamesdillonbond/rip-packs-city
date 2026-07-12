import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-sets.
// Guard: `wallet` query param required -> 400, before any Cadence / AllDay GQL
// fan-out. Mock @/lib/flow + @/lib/allday so the module imports cleanly; we pin
// the param guard AND the 2xx early-return success path: a valid 0x wallet
// resolves directly (no GQL) and fcl.query (mocked -> []) yields no owned
// moments, so the route returns an empty, well-formed set list.

vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/allday", () => ({ alldayGraphql: async () => ({}) }))

import { GET } from "@/app/api/allday-sets/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-sets" + qs)

describe("GET /api/allday-sets", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("200s with an empty set list when the wallet owns no moments", async () => {
    const res = await GET(req("?wallet=0xabcdef0123456789"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedAddress).toBe("0xabcdef0123456789")
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })
})
