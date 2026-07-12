import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-sets.
// Guard: `wallet` query param required → 400, before any Cadence / AllDay GQL
// fan-out. Mock @/lib/flow + @/lib/allday so the module imports cleanly; we pin
// the param guard (the happy path is a live on-chain + GQL set walk).

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
})
