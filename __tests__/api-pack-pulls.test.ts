import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/pack-pulls (GET + POST).
// GET: get_pack_pull_stats(p_pack_listing_id) wrapper — pins missing-param 400,
// rpc-error 500, happy 200. POST: community pull submission — pins the invalid
// JSON 400, missing packListingId 400, invalid tier 400, unknown collection
// 400, and the rate-limited insert happy 200.

const state: { rpc: any; rpcErr: any; count: number; ipCount: number | null; countErr: any; insertErr: any; inserted: unknown[] } = {
  rpc: [],
  rpcErr: null,
  count: 0,
  // The all-packs count for the IP; null = same as `count` (the old single-query shape).
  ipCount: null,
  countErr: null,
  insertErr: null,
  inserted: [],
}

vi.mock("@supabase/supabase-js", () => {
  // One builder per from(): the per-pack count filters on pack_listing_id, the
  // all-packs count does not — that is how the two reads are told apart.
  const makeBuilder = () => {
    let perPack = false
    const builder: any = {
      select: () => builder,
      eq: (col: string) => { if (col === "pack_listing_id") perPack = true; return builder },
      gte: () => builder,
      insert: async (row: unknown) => { state.inserted.push(row); return { error: state.insertErr } },
      then: (resolve: any) =>
        resolve({ count: perPack || state.ipCount == null ? state.count : state.ipCount, error: state.countErr }),
    }
    return builder
  }
  return {
    createClient: () => ({
      rpc: async () => ({ data: state.rpc, error: state.rpcErr }),
      from: () => makeBuilder(),
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
  state.ipCount = null
  state.countErr = null
  state.inserted = []
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

  // 2026-09-26: a failed count used to SKIP the cap and fall through to the
  // service-role insert — an anonymous flood path during any DB slowdown.
  it("FAILS CLOSED when the rate-limit count errors: 503, and nothing is inserted", async () => {
    state.countErr = { message: "canceling statement due to statement timeout" }
    const res = await POST(post({ packListingId: "abc", tier: "RARE" }))
    expect(res.status).toBe(503)
    expect(state.inserted).toHaveLength(0)
  })

  // 2026-11-17: the per-pack cap is keyed on a caller-supplied id, so rotating
  // ids wrote without limit. The all-packs cap does not depend on the id.
  it("429s on the all-packs daily cap even when THIS pack is under its own cap, and inserts nothing", async () => {
    state.count = 0
    state.ipCount = 100
    const res = await POST(post({ packListingId: "a-fresh-id", tier: "RARE" }))
    expect(res.status).toBe(429)
    expect(state.inserted).toHaveLength(0)
  })

  it("400s on a packListingId that is not a short key (length / charset), and inserts nothing", async () => {
    for (const bad of ["x".repeat(81), "abc def", "<script>", "a/b"]) {
      const res = await POST(post({ packListingId: bad, tier: "RARE" }))
      expect(res.status).toBe(400)
    }
    expect(state.inserted).toHaveLength(0)
  })
})
