import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sets/[set_id]. Dynamic route:
// 2nd handler arg is { params: Promise<{ set_id }> }. Guards a non-UUID set_id
// (400 before the RPC), maps a "not found" rpc error to 404, and passes data
// through on success. Pins those plus the generic rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/sets/[set_id]/route"

const req = () => ({ url: "https://t/api/analytics/sets/x" }) as any
const ctx = (set_id: string) => ({ params: Promise.resolve({ set_id }) }) as any
const UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/sets/[set_id]", () => {
  it("400s on a malformed (non-UUID) set_id", async () => {
    const res = await GET(req(), ctx("not-a-uuid"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_set_id")
  })

  it("404s when the rpc reports the set is not found", async () => {
    rpc.error = { message: "set not found" }
    const res = await GET(req(), ctx(UUID))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("set_not_found")
  })

  it("returns the set detail payload verbatim on success", async () => {
    rpc.data = { set_id: UUID, name: "Base Set", editions: [] }
    const res = await GET(req(), ctx(UUID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ set_id: UUID, name: "Base Set", editions: [] })
  })

  it("500s on a generic rpc error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req(), ctx(UUID))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_detail_failed")
  })
})
