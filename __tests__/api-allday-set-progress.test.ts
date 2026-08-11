import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-set-progress.
// Guard: `wallet` query param required → 400. Otherwise wraps the
// get_allday_set_progress SECDEF RPC. Mock @/lib/supabase to pin the guard, the
// RPC-error 500, and the mapped happy shape.

const rpc: { data: any; error: any; throw: any } = { data: null, error: null, throw: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throw) throw rpc.throw
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/allday-set-progress/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-set-progress" + qs)

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  rpc.throw = null
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

  it("returns an empty payload when the detail row lacks a setId", async () => {
    // `d` is truthy but has no setId -> the same "unknown set" empty branch.
    rpc.data = { setName: "orphan", totalPlays: 0 }
    const res = await GET(req("?wallet=0xabc&set=nope"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })

  it("500s when the detail RPC returns an error", async () => {
    rpc.error = { message: "detail boom" }
    const res = await GET(req("?wallet=0xabc&set=s1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("detail boom")
  })

  it("500s when the detail RPC throws (fatal catch)", async () => {
    rpc.throw = new Error("detail fatal")
    const res = await GET(req("?wallet=0xabc&set=s1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("detail fatal")
  })

  it("defaults owned/missing fields and counts a complete detail set", async () => {
    // owned/missing null -> `?? []`; owned row lacks playerName/tier/serial -> defaults;
    // completionPct >= 100 -> tier 'complete' -> completeSets 1.
    rpc.data = {
      setId: "cmp",
      setName: "Complete Set",
      totalPlays: 2,
      ownedPlays: 2,
      missingPlays: 0,
      completionPct: 100,
      owned: null,
      missing: null,
    }
    const res = await GET(req("?wallet=0xabc&set=cmp"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.completeSets).toBe(1)
    expect(body.inProgressSets).toBe(0)
    const s = body.sets[0]
    expect(s.owned).toEqual([])
    expect(s.missing).toEqual([])
    expect(s.completionPct).toBe(100)
  })

  it("counts a not-started detail set and defaults an owned row's missing fields", async () => {
    // ownedPlays 0 -> notStartedSets 1; owned row missing all optional fields -> defaults.
    rpc.data = {
      setId: "ns",
      setName: "Not Started",
      totalPlays: 3,
      ownedPlays: 0,
      missingPlays: 3,
      completionPct: 0,
      owned: [{}],
      missing: [{}],
    }
    const res = await GET(req("?wallet=0xabc&set=ns"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.notStartedSets).toBe(1)
    const s = body.sets[0]
    expect(s.owned[0]).toMatchObject({ playId: "", playerName: "—", tier: "COMMON", serialNumber: null, thumbnailUrl: null })
    expect(s.missing[0]).toMatchObject({ playId: "", playerName: "—", tier: "COMMON", lowestAsk: null, fmv: null })
  })

  // ── main list (no ?set) branches ───────────────────────────────────────────
  it("maps missingPreview rows with defaults and computes the set counters", async () => {
    rpc.data = {
      sets: [
        // in-progress with a preview row missing playerName/tier/thumb/fmv -> defaults
        { setId: "a", setName: "A", ownedPlays: 2, totalPlays: 5, missingPlays: 3, completionPct: 40, missingPreview: [{}] },
        // complete set
        { setId: "b", setName: "B", ownedPlays: 5, totalPlays: 5, missingPlays: 0, completionPct: 100 },
        // not started
        { setId: "c", setName: "C", ownedPlays: 0, totalPlays: 4, missingPlays: 4, completionPct: 0 },
      ],
    }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(3)
    expect(body.completeSets).toBe(1)
    expect(body.inProgressSets).toBe(1)
    expect(body.notStartedSets).toBe(1)
    const a = body.sets.find((s: any) => s.setId === "a")
    expect(a.missing).toHaveLength(1)
    expect(a.missing[0]).toMatchObject({ playId: "a:preview:0", playerName: "—", tier: "COMMON", thumbnailUrl: null, fmv: null })
  })

  it("returns an empty sets payload when the RPC data is null", async () => {
    rpc.data = null
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
    // falls back to the request wallet when the RPC omits it
    expect(body.wallet).toBe("0xabc")
    expect(body.resolvedAddress).toBe("0xabc")
  })

  it("tolerates a non-array sets field", async () => {
    rpc.data = { sets: "not-an-array" }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect((await res.json()).sets).toEqual([])
  })

  it("500s when the main RPC throws (fatal catch)", async () => {
    rpc.throw = new Error("list fatal")
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("list fatal")
  })
})
