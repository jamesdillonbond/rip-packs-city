import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sales/leaderboard. Guards on an
// invalid role (400 before the RPC). Enriches rpc rows with resolved usernames
// via @/lib/flowty-username (mocked). Pins the role guard, the happy enriched
// path ({ role, rows[].username }), and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/flowty-username", () => ({
  resolveUsernames: async () => new Map<string, string>([["0xabc", "alice"]]),
  displayName: (addr: string, names: Map<string, string>) => names.get(addr) ?? addr,
}))

import { GET } from "@/app/api/analytics/sales/leaderboard/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/sales/leaderboard", () => {
  it("400s on an invalid role", async () => {
    const res = await GET(req("https://t/api/analytics/sales/leaderboard?role=whale"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_role")
  })

  it("enriches rows with resolved usernames on the happy path", async () => {
    rpc.data = [{ addr: "0xabc", volume: 100 }]
    const res = await GET(req("https://t/api/analytics/sales/leaderboard?role=buyer"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe("buyer")
    expect(body.rows[0].username).toBe("alice")
    expect(body.rows[0].addr).toBe("0xabc")
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req("https://t/api/analytics/sales/leaderboard?role=seller"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("leaderboard_failed")
  })
})
