import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/market-feed (GET; POST is an alias).
// Auth via isAuthorized: Bearer CRON_SECRET OR ?token=MARKET_FEED_TOKEN; if
// NEITHER secret is configured it allows (dev mode). Pins: 401 when CRON_SECRET
// is set + no header, and the empty happy path (no editions in Supabase → []).

vi.mock("@/lib/topshot", () => ({
  topshotGraphql: async () => ({ searchEditions: { data: [] } }),
}))
vi.mock("@/lib/supabase", () => {
  const result: any = { data: [], error: null }
  const b: any = {
    from: () => b, select: () => b, not: () => b, filter: () => b, in: () => b,
    limit: () => b,
    then: (res: any) => res(result),
    rpc: async () => ({ data: [] }),
  }
  return { supabaseAdmin: b, supabase: b }
})

import { GET } from "@/app/api/market-feed/route"

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe("GET /api/market-feed", () => {
  it("401s when CRON_SECRET is configured and no Authorization header is sent", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret")
    const res = await GET(makeReq({ url: "https://t/api/market-feed", method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("returns [] when no edition keys exist (dev-mode allow, empty Supabase)", async () => {
    // Neither CRON_SECRET nor MARKET_FEED_TOKEN set → isAuthorized allows.
    vi.stubEnv("CRON_SECRET", "")
    vi.stubEnv("MARKET_FEED_TOKEN", "")
    const res = await GET(makeReq({ url: "https://t/api/market-feed", method: "GET" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
