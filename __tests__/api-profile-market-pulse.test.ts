import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/market-pulse.
// Public read (no auth, no required param — defaults collectionId to
// nba-top-shot). All three DB legs (fmv_snapshots count, editions count,
// cached_listings floors) are wrapped in non-fatal try/catch, so the handler
// always returns 200 with the pulse shape. Mocked builders resolve empty, so
// floors are null. A unique collectionId per test avoids the 60s in-memory
// cache leaking between cases.

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

// Table-aware result: overrides[<table>] wins, else the empty default. Lets a
// test prove snapshotsToday reads the exact `count` (not the row-length, which
// PostgREST clamps at 1,000).
const tableResults: Record<string, any> = {}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => chain(() => tableResults[table] ?? { data: [], count: 0, error: null }),
  },
}))

beforeEach(() => {
  for (const k of Object.keys(tableResults)) delete tableResults[k]
})

import { GET } from "@/app/api/profile/market-pulse/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

describe("GET /api/profile/market-pulse", () => {
  it("returns the pulse shape for the default collection", async () => {
    const res = await GET(req("https://t/api/profile/market-pulse"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collectionId).toBe("nba-top-shot")
    expect(body).toHaveProperty("commonFloor")
    expect(body).toHaveProperty("rareFloor")
    expect(body).toHaveProperty("legendaryFloor")
    expect(body).toHaveProperty("indexedEditions")
    expect(body).toHaveProperty("snapshotsToday")
    expect(body).toHaveProperty("updatedAt")
  })

  it("echoes back the requested collectionId with null floors when listings are empty", async () => {
    const res = await GET(req("https://t/api/profile/market-pulse?collectionId=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collectionId).toBe("nfl-all-day")
    expect(body.commonFloor).toBeNull()
    expect(body.rareFloor).toBeNull()
    expect(body.legendaryFloor).toBeNull()
  })

  it("reports snapshotsToday from the exact count, not the PostgREST-clamped row length", async () => {
    // A collection that computes >1,000 snapshots/day (Top Shot ~4,200). The
    // head:true count returns 4243 while a body read would clamp at 1,000.
    tableResults.fmv_snapshots = { data: Array.from({ length: 1000 }, () => ({})), count: 4243, error: null }
    const res = await GET(req("https://t/api/profile/market-pulse?collectionId=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    // If the route read snaps.length it would be 1000; it must read count.
    expect(body.snapshotsToday).toBe(4243)
  })
})
