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

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(() => ({ data: [], count: 0, error: null })),
  },
}))

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
})
