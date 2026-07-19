import { describe, it, expect, beforeEach, vi } from "vitest"

// Drives the DB-backed set-tracker's CLASSIFICATION logic end-to-end (the route
// is pure Postgres — no live GraphQL — so the mapping is fully testable via a
// mocked rpc). The existing api-sets.test.ts covers only the 400/empty/500
// guards; this pins classifyTier's five tier branches, the bottleneck = most-
// expensive-missing-piece rule, lowestSingleAsk/listedCount, the mapMissing
// ask→fmv fallback, and the detail-view completion math.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))
vi.mock("@/lib/chains/flow/flow-resolve", () => ({
  resolveToFlowAddress: async (w: string) => w,
}))

import { GET } from "@/app/api/sets/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

// Minimal RpcSetSummary row for the list view.
function setRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    setId: "S1",
    setName: "Set One",
    series: 4,
    setTier: null,
    totalPlays: 5,
    ownedPlays: 0,
    missingPlays: 5,
    completionPct: 0,
    estimatedCostToComplete: 0,
    missingPreview: [],
    ...o,
  }
}

async function listTier(row: Record<string, unknown>) {
  state.data = { sets: [row] }
  const res = await GET(req("https://t/api/sets?wallet=0xabc"))
  expect(res.status).toBe(200)
  const body = await res.json()
  return body.sets[0]
}

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/sets — classifyTier branches (list view)", () => {
  it("completionPct 100 → complete (and counts toward completeSets)", async () => {
    state.data = { sets: [setRow({ completionPct: 100, ownedPlays: 5, missingPlays: 0 })] }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    const body = await res.json()
    expect(body.sets[0].tier).toBe("complete")
    expect(body.completeSets).toBe(1)
    expect(body.inProgressSets).toBe(0)
  })

  it("1 or 2 missing plays → almost_there (regardless of cost)", async () => {
    expect((await listTier(setRow({ missingPlays: 1, completionPct: 80 }))).tier).toBe("almost_there")
    expect((await listTier(setRow({ missingPlays: 2, completionPct: 60 }))).tier).toBe("almost_there")
  })

  it(">2 missing with a positive estimated cost → completable", async () => {
    expect((await listTier(setRow({ missingPlays: 3, estimatedCostToComplete: 42 }))).tier).toBe("completable")
  })

  it(">2 missing with zero estimated cost → unpriced", async () => {
    expect((await listTier(setRow({ missingPlays: 3, estimatedCostToComplete: 0 }))).tier).toBe("unpriced")
  })

  it("no missing plays but not complete (empty/zero set) → incomplete fallback", async () => {
    const s = await listTier(setRow({ totalPlays: 0, ownedPlays: 0, missingPlays: 0, completionPct: 0 }))
    expect(s.tier).toBe("incomplete")
  })

  it("rounds a fractional completionPct", async () => {
    expect((await listTier(setRow({ completionPct: 66.6, missingPlays: 3, estimatedCostToComplete: 1 }))).completionPct).toBe(67)
  })
})

describe("GET /api/sets — bottleneck + ask aggregation", () => {
  it("bottleneck is the MOST expensive missing piece; lowestSingleAsk/listedCount reflect real asks", async () => {
    const s = await listTier(
      setRow({
        missingPlays: 3,
        estimatedCostToComplete: 55,
        missingPreview: [
          { playId: 1, playerName: "Cheap", tier: "COMMON", lowAsk: 5, fmvUsd: 4, thumbnailUrl: null, topshotUrl: "" },
          { playId: 2, playerName: "Pricey", tier: "RARE", lowAsk: 40, fmvUsd: 30, thumbnailUrl: null, topshotUrl: "" },
          { playId: 3, playerName: "NoListing", tier: "COMMON", lowAsk: null, fmvUsd: null, thumbnailUrl: null, topshotUrl: "" },
        ],
      }),
    )
    expect(s.bottleneckPrice).toBe(40)
    expect(s.bottleneckPlayerName).toBe("Pricey")
    expect(s.lowestSingleAsk).toBe(5)
    // NoListing has neither ask nor fmv → lowestAsk null → not counted as listed.
    expect(s.listedCount).toBe(2)
  })

  it("mapMissing falls back to fmv when there is no live ask", async () => {
    const s = await listTier(
      setRow({
        missingPlays: 3,
        estimatedCostToComplete: 1,
        missingPreview: [
          { playId: 9, playerName: "FmvOnly", tier: "COMMON", lowAsk: null, fmvUsd: 12, thumbnailUrl: null, topshotUrl: "" },
        ],
      }),
    )
    expect(s.missing[0].lowestAsk).toBe(12) // ask fell back to fmv
    expect(s.missing[0].fmv).toBe(12)
    expect(s.listedCount).toBe(1) // fmv fallback still counts as a usable floor
  })
})

describe("GET /api/sets?set= — detail view completion math", () => {
  it("computes completionPct from owned/total and sums missing asks", async () => {
    state.data = {
      setId: "S1",
      setName: "Set One",
      series: 4,
      setTier: null,
      totalPlays: 4,
      ownedPlays: 3,
      owned: [{ playId: 1, playerName: "Owned", tier: "COMMON", serialNumber: 7, thumbnailUrl: null, topshotUrl: "" }],
      missing: [{ playId: 2, playerName: "Gap", tier: "RARE", lowAsk: 15, fmvUsd: 10, thumbnailUrl: null, topshotUrl: "" }],
    }
    const res = await GET(req("https://t/api/sets?wallet=0xabc&set=S1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(1)
    const set = body.sets[0]
    expect(set.completionPct).toBe(75) // 3/4
    expect(set.tier).toBe("almost_there") // 1 missing play
    expect(set.totalMissingCost).toBe(15)
    expect(set.ownedCount).toBe(3)
    expect(body.inProgressSets).toBe(1)
  })

  it("returns the zero-state envelope when the detail RPC yields no setId", async () => {
    state.data = null
    const res = await GET(req("https://t/api/sets?wallet=0xabc&set=missing"))
    const body = await res.json()
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })
})
