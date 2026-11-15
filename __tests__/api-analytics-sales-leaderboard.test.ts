import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sales/leaderboard. Guards on an
// invalid role (400 before the RPC). Enriches rpc rows with resolved usernames
// via @/lib/flowty-username (mocked). Pins the role guard, the happy enriched
// path ({ role, rows[].username }), and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))
vi.mock("@/lib/flowty-username", () => ({
  resolveUsernames: async () => new Map<string, string>([["0xabc", "alice"]]),
  displayName: (addr: string, names: Map<string, string>) => names.get(addr) ?? addr,
}))

import { GET } from "@/app/api/analytics/sales/leaderboard/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

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
    // Re-pinned 2026-11-14: the shared apiErrorResponse body (a readable error, a code, retryable).
    const b = await res.json()
    expect(b.error).toBe("Couldn't load the leaderboard.")
    expect(typeof b.retryable).toBe("boolean")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req("https://t/api/analytics/sales/leaderboard?role=seller"))
    expect(res.status).toBe(500)
    // Re-pinned 2026-11-14: the shared apiErrorResponse body (a readable error, a code, retryable).
    const b = await res.json()
    expect(b.error).toBe("Couldn't load the leaderboard.")
    expect(typeof b.retryable).toBe("boolean")
  })

  // 2026-11-14 (Collectors review): the RPC passes an unknown key through and
  // matches nothing, so a typo answered 200 with an empty board — "no buyers".
  it("an unknown collection key is a 400, never an empty leaderboard", async () => {
    const res = await GET(req("https://t/api/analytics/sales/leaderboard?collections=topshoot"))
    expect(res.status).toBe(400)
    const b = await res.json()
    expect(b.error).toBe("invalid_collection")
    expect(b.unknown).toEqual(["topshoot"])
    expect(b.rows).toBeUndefined()
  })
  it("CONTROL: short keys and DB slugs from the registry are accepted", async () => {
    for (const k of ["topshot", "allday,golazos", "pinnacle", "ufc", "nba_top_shot", "candy_mlb"]) {
      const res = await GET(req(`https://t/api/analytics/sales/leaderboard?collections=${k}`))
      expect(res.status, k).not.toBe(400)
    }
  })
})
