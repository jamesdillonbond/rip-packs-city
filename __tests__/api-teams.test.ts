import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/teams. Reference-data endpoint backed by
// get_teams_for_league. Pins the league-validation 400 guard (isLeague) + the
// authed-free happy path. Mocks supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: [], error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/teams/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = []; rpc.error = null })

describe("GET /api/teams", () => {
  it("400s without a valid league", async () => {
    expect((await GET(req("https://t/api/teams"))).status).toBe(400)
    expect((await GET(req("https://t/api/teams?league=XYZ"))).status).toBe(400)
  })

  it("returns teams for a valid league", async () => {
    rpc.data = [{ slug: "lakers", name: "Lakers", has_moments: true }]
    const res = await GET(req("https://t/api/teams?league=NBA"))
    expect(res.status).toBe(200)
    expect((await res.json()).teams).toHaveLength(1)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db" }
    expect((await GET(req("https://t/api/teams?league=NBA"))).status).toBe(500)
  })
})
