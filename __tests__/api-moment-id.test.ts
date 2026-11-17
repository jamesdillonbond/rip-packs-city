import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/moment/[id] (public, no auth).
// Thin wrapper over the get_moment_detail(p_id) SECDEF RPC. Pins: the
// missing-id 400, rpc-error 500, payload.ok===false 404, and the happy 200.
// The [id] comes from ctx.params (a Promise, awaited by the handler).

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/moment/[id]/route"

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any
const req = {} as any

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/moment/[id]", () => {
  it("400s on a missing id", async () => {
    const res = await GET(req, ctx(""))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("missing_id")
  })

  it("500s on an rpc error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req, ctx("12345"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    const body = await res.json()
    expect(body.error).not.toContain("db down")
    // ...and a lookup FAILURE must not reuse the route's own "no such moment"
    // verdict, which is `ok: false` at 404.
    expect(body.ok).toBeUndefined()
  })

  it("404s when the payload resolves ok:false", async () => {
    state.data = { ok: false, error: "not_found", input: "12345" }
    const res = await GET(req, ctx("12345"))
    expect(res.status).toBe(404)
    expect((await res.json()).ok).toBe(false)
  })

  it("404s when the rpc returns null (not_found synthesized)", async () => {
    state.data = null
    const res = await GET(req, ctx("12345"))
    expect(res.status).toBe(404)
  })

  it("returns 200 with the payload on a hit", async () => {
    state.data = { ok: true, edition: { id: "e1" }, fmv: { fmv_usd: 5 } }
    const res = await GET(req, ctx("12345"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.edition).toEqual({ id: "e1" })
  })
})
