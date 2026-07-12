import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-set-progress.
// Guard: `wallet` query param required → 400. Otherwise wraps the
// get_allday_set_progress SECDEF RPC. Mock @/lib/supabase to pin the guard, the
// RPC-error 500, and the mapped happy shape.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/allday-set-progress/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-set-progress" + qs)

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/allday-set-progress", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "boom" }
    expect((await GET(req("?wallet=0xabc"))).status).toBe(500)
  })

  it("maps the RPC response into the sets payload", async () => {
    rpc.data = {
      wallet: "0xabc",
      resolvedAddress: "0xabc",
      sets: [
        { setId: "s1", setName: "Set One", ownedPlays: 3, totalPlays: 10, missingPlays: 7, completionPct: 30 },
      ],
      generatedAt: "2026-07-12T00:00:00Z",
    }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(1)
    expect(body.sets[0].setName).toBe("Set One")
    expect(body.sets[0].completionPct).toBe(30)
  })
})
