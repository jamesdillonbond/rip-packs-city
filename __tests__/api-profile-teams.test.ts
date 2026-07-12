import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/teams. This is a PUBLIC ownerKey-
// driven endpoint (no session gate — holdings are public on a showcase), so
// the guards are param-based, not auth-based. Pins GET 400 (ownerKey required),
// the GET "unknown owner → {teams:[]}" happy path, and the POST body 400s.

const state: { single: any; result: any } = {
  single: { data: null, error: null },
  result: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, delete: () => b, eq: () => b,
      ilike: () => b, order: () => b,
      maybeSingle: async () => state.single,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { GET, POST } from "@/app/api/profile/teams/route"

const req = (url: string, body?: any, throws = false) =>
  ({
    nextUrl: new URL(url),
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.single = { data: null, error: null }
  state.result = { data: [], error: null }
})

describe("/api/profile/teams", () => {
  it("GET 400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/teams"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("GET returns empty teams for an unknown owner", async () => {
    state.single = { data: null, error: null } // resolveUserId → null
    const res = await GET(req("https://t/api/profile/teams?ownerKey=nobody"))
    expect(res.status).toBe(200)
    expect((await res.json()).teams).toEqual([])
  })

  it("POST 400s on invalid JSON body", async () => {
    const res = await POST(req("https://t/api/profile/teams", undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("POST 400s without ownerKey", async () => {
    expect((await POST(req("https://t/api/profile/teams", { teams: [] }))).status).toBe(400)
  })

  it("POST 400s when teams is not an array", async () => {
    const res = await POST(req("https://t/api/profile/teams", { ownerKey: "trevor", teams: "no" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("teams must be an array")
  })
})
