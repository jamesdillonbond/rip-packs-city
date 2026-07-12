import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/packs/history/[pack_listing_id].
// Dynamic route: 2nd handler arg is { params: Promise<{ pack_listing_id }> }.
// Wraps analytics_packs_history via rpcWithRetry(supabaseAdmin, ...). Pins the
// empty-id 400 guard (returns before the RPC), the happy pass-through, and the
// rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/packs/history/[pack_listing_id]/route"

const req = (url = "https://t/api/analytics/packs/history/abc") => ({ url }) as any
const ctx = (pack_listing_id: string) => ({ params: Promise.resolve({ pack_listing_id }) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/packs/history/[pack_listing_id]", () => {
  it("400s on an empty pack_listing_id", async () => {
    const res = await GET(req(), ctx("   "))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_pack_listing_id")
  })

  it("returns the rpc payload verbatim on the happy path", async () => {
    rpc.data = { points: [{ price: 10 }] }
    const res = await GET(req("https://t/api/analytics/packs/history/abc?days=7"), ctx("abc"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ points: [{ price: 10 }] })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "boom" }
    const res = await GET(req(), ctx("abc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_history_failed")
  })
})
