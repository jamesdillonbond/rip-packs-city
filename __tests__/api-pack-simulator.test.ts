import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pack-simulator.
// Thin wrapper over get_pack_for_simulator(p_collection_id, p_dist_id). Pins:
// missing-params 400, rpc-error 500, the RPC payload passthrough, and the
// null-data "pack not found" fallback (still 200).

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/pack-simulator/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/pack-simulator", () => {
  it("400s when collectionId or distId is missing", async () => {
    const res = await GET(req("https://t/api/pack-simulator?collectionId=uuid"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId and distId are required")
  })

  it("500s on an rpc error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/pack-simulator?collectionId=uuid&distId=d1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })

  it("passes the RPC payload through on a hit", async () => {
    state.data = { pack: { dist_id: "d1" }, pool: [], metrics: {}, note: null }
    const res = await GET(req("https://t/api/pack-simulator?collectionId=uuid&distId=d1"))
    expect(res.status).toBe(200)
    expect((await res.json()).pack.dist_id).toBe("d1")
  })

  it("falls back to a pack-not-found body when the RPC returns null", async () => {
    state.data = null
    const res = await GET(req("https://t/api/pack-simulator?collectionId=uuid&distId=d1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBe("pack not found")
    expect(body.dist_id).toBe("d1")
  })
})
