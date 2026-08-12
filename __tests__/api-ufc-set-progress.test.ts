import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/ufc-set-progress. Wraps get_ufc_set_progress.
// Missing wallet → 400; a valid wallet maps the RPC response into the /api/sets
// shape; an RPC error → 500. Mocks supabaseAdmin.rpc.

const rpc: { data: any; error: any; throws: boolean } = { data: {}, error: null, throws: false }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/ufc-set-progress/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = {}; rpc.error = null; rpc.throws = false })

describe("GET /api/ufc-set-progress", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/ufc-set-progress"))).status).toBe(400)
  })

  it("returns the mapped set-progress shape for a wallet", async () => {
    rpc.data = { sets: [{ setId: "s1", setName: "Set 1", ownedPlays: 2, totalPlays: 5, missingPlays: 3, completionPct: 40 }] }
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(1)
    expect(body.sets[0].completionPct).toBe(40)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db" }
    expect((await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))).status).toBe(500)
  })

  it("400s when the wallet param is only whitespace (trimmed to empty)", async () => {
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=%20%20"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("maps missingPreview rows with tier/player fallbacks and passes cost through", async () => {
    rpc.data = {
      wallet: "0xRPC",
      resolvedAddress: "0xRESOLVED",
      generatedAt: "2026-01-01T00:00:00Z",
      sets: [
        {
          setId: "s1",
          setName: "Set 1",
          setTier: "CHAMPION",
          ownedPlays: 1,
          totalPlays: 3,
          missingPlays: 2,
          completionPct: 33.6,
          estimatedCostToComplete: 250,
          missingPreview: [
            { playerName: "Fighter A", tier: "contender", fmvUsd: 12, thumbnailUrl: "http://img/a.png" },
            { playerName: null, tier: null, fmvUsd: null, thumbnailUrl: null }, // fallbacks
          ],
        },
      ],
    }
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    // passthrough of RPC-provided identity + timestamp
    expect(body.wallet).toBe("0xRPC")
    expect(body.resolvedAddress).toBe("0xRESOLVED")
    expect(body.generatedAt).toBe("2026-01-01T00:00:00Z")
    const s = body.sets[0]
    expect(s.completionPct).toBe(34) // Math.round(33.6)
    expect(s.totalMissingCost).toBe(250)
    expect(s.missing).toHaveLength(2)
    expect(s.missing[0]).toMatchObject({ playId: "s1:preview:0", playerName: "Fighter A", tier: "CONTENDER", fmv: 12 })
    // second preview takes the "—" / FANDOM / null fallbacks
    expect(s.missing[1]).toMatchObject({ playerName: "—", tier: "FANDOM", fmv: null, thumbnailUrl: null })
  })

  it("classifies complete / in-progress / not-started sets across the summary counts", async () => {
    rpc.data = {
      sets: [
        { setId: "done", setName: "Done", ownedPlays: 3, totalPlays: 3, missingPlays: 0, completionPct: 100 },
        { setId: "wip", setName: "WIP", ownedPlays: 1, totalPlays: 4, missingPlays: 3, completionPct: 25 },
        { setId: "none", setName: "None", ownedPlays: 0, totalPlays: 5, missingPlays: 5, completionPct: 0 },
      ],
    }
    const body = await (await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))).json()
    expect(body.totalSets).toBe(3)
    expect(body.completeSets).toBe(1) // tier === "complete" at 100% / 0 missing
    expect(body.inProgressSets).toBe(1) // owned>0 && <100%
    expect(body.notStartedSets).toBe(1) // owned===0
  })

  it("returns an empty set list when the RPC yields no sets array (data null / non-array)", async () => {
    rpc.data = null
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
    // falls back to the request wallet + a generated timestamp
    expect(body.wallet).toBe("0xabc")
    expect(typeof body.generatedAt).toBe("string")
  })

  it("500s (fatal catch) when the RPC call throws rather than returning an error", async () => {
    rpc.throws = true
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("connection reset")
  })
})
