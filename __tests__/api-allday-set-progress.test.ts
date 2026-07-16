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

  // ── per-set detail (?set=<setId>) ──────────────────────────────────────────
  it("maps get_allday_set_detail into one set with full owned + missing lists", async () => {
    rpc.data = {
      setId: "011f50fb",
      setName: "Buccaneers Vintage",
      setTier: "COMMON",
      totalPlays: 3,
      ownedPlays: 2,
      missingPlays: 1,
      completionPct: 66.7,
      estimatedCostToComplete: 0.88,
      owned: [
        { playId: "2801", playerName: "Brad Johnson", tier: "uncommon", serialNumber: 1663, thumbnailUrl: "https://x/2801.png" },
      ],
      missing: [
        { playId: "2803", playerName: "John Lynch", tier: "uncommon", fmvUsd: 0.88, thumbnailUrl: "https://x/2803.png" },
      ],
    }
    const res = await GET(req("?wallet=0xabc&set=011f50fb"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(1)
    const s = body.sets[0]
    expect(s.setName).toBe("Buccaneers Vintage")
    expect(s.completionPct).toBe(67) // rounded
    expect(s.owned).toHaveLength(1)
    expect(s.owned[0]).toMatchObject({ playId: "2801", serialNumber: 1663, tier: "UNCOMMON" })
    expect(s.owned[0].topshotUrl).toContain("nflallday.com/search?query=Brad")
    expect(s.missing).toHaveLength(1)
    expect(s.missing[0]).toMatchObject({ playId: "2803", tier: "UNCOMMON", lowestAsk: null, fmv: 0.88 })
  })

  it("returns an empty payload when the detail RPC finds no set", async () => {
    rpc.data = null
    const res = await GET(req("?wallet=0xabc&set=nope"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })
})
