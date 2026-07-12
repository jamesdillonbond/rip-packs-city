import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/ufc-set-progress. Wraps get_ufc_set_progress.
// Missing wallet → 400; a valid wallet maps the RPC response into the /api/sets
// shape; an RPC error → 500. Mocks supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: {}, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/ufc-set-progress/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = {}; rpc.error = null })

describe("GET /api/ufc-set-progress", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/ufc-set-progress"))).status).toBe(400)
  })

  it("returns the mapped set-progress shape for a wallet", async () => {
    rpc.data = { sets: [{ setId: "s1", setName: "Set 1", ownedPlays: 2, totalPlays: 5, missingPlays: 3, completionPct: 40 }] }
    const res = await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSets).toBe(1)
    expect(body.sets[0].completionPct).toBe(40)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db" }
    expect((await GET(req("https://t/api/ufc-set-progress?wallet=0xabc"))).status).toBe(500)
  })
})
