import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/pack-pulls (GET + POST).
// GET: get_pack_pull_stats(p_pack_listing_id) wrapper — pins missing-param 400,
// rpc-error 500, happy 200. POST: community pull submission — pins the invalid
// JSON 400, missing packListingId 400, invalid tier 400, unknown collection
// 400, and the rate-limited insert happy 200.

const state: { rpc: any; rpcErr: any; count: number; countErr: any; insertErr: any } = {
  rpc: [],
  rpcErr: null,
  count: 0,
  countErr: null,
  insertErr: null,
}

vi.mock("@supabase/supabase-js", () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    insert: async () => ({ error: state.insertErr }),
    then: (resolve: any) => resolve({ count: state.count, error: state.countErr }),
  }
  return {
    createClient: () => ({
      rpc: async () => ({ data: state.rpc, error: state.rpcErr }),
      from: () => builder,
    }),
  }
})

import { GET, POST } from "@/app/api/pack-pulls/route"

const getReq = (url: string) => ({ nextUrl: new URL(url) }) as any

function post(body: unknown): NextRequest {
  return new NextRequest("https://t/api/pack-pulls", {
    method: "POST",
    headers: new Headers({ "x-forwarded-for": "1.2.3.4" }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  state.rpc = []
  state.rpcErr = null
  state.count = 0
  state.countErr = null
  state.insertErr = null
})

describe("GET /api/pack-pulls", () => {
  it("400s when packListingId is missing", async () => {
    const res = await GET(getReq("https://t/api/pack-pulls"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("500s on an rpc error", async () => {
    state.rpcErr = { message: "db" }
    const res = await GET(getReq("https://t/api/pack-pulls?packListingId=abc"))
    expect(res.status).toBe(500)
  })

  it("returns the stats array on a hit", async () => {
    state.rpc = [{ tier: "RARE", pulls: 3 }]
    const res = await GET(getReq("https://t/api/pack-pulls?packListingId=abc"))
    expect(res.status).toBe(200)
    expect((await res.json()).stats).toHaveLength(1)
  })
})

describe("POST /api/pack-pulls", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when packListingId is missing", async () => {
    const res = await POST(post({ tier: "RARE" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("400s on an invalid tier", async () => {
    const res = await POST(post({ packListingId: "abc", tier: "MYTHIC" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid tier")
  })

  it("400s on an unknown collection", async () => {
    const res = await POST(post({ packListingId: "abc", tier: "RARE", collection: "disney-pinnacle" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns ok on a valid submission under the rate limit", async () => {
    const res = await POST(post({ packListingId: "abc", tier: "RARE", playerName: "LeBron", serialNumber: 5 }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("429s when the per-day IP limit is exceeded", async () => {
    state.count = 20
    const res = await POST(post({ packListingId: "abc", tier: "RARE" }))
    expect(res.status).toBe(429)
  })
})
