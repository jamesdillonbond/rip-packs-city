import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/trade-hub/offers. Every verb is cookie-auth
// gated → fail-closed 401 when unauthenticated (getCurrentUser → null). Success
// paths (signed-in user): GET lists the user's offers, POST upserts one and
// echoes its id, DELETE removes by id. supabaseAdmin is a self-referential
// chainable — GET/DELETE await the builder ({ data, error }); POST terminates
// on maybeSingle.

const state: { user: any; listData: any; single: any } = {
  user: null,
  listData: [],
  single: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, order: () => b, upsert: () => b, delete: () => b,
    maybeSingle: async () => state.single,
    then: (resolve: any) => resolve({ data: state.listData, error: null }),
  }
  return { supabaseAdmin: { from: () => b } }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))

import { GET, POST, DELETE } from "@/app/api/trade-hub/offers/route"

const postReq = (body: any) => ({ json: async () => body }) as any
const delReq = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.listData = []
  state.single = { data: null, error: null }
})

describe("/api/trade-hub/offers — fail-closed auth", () => {
  it("GET 401s when unauthenticated", async () => {
    expect((await GET()).status).toBe(401)
  })
  it("POST 401s when unauthenticated", async () => {
    expect((await POST(postReq({}))).status).toBe(401)
  })
  it("DELETE 401s when unauthenticated", async () => {
    expect((await DELETE(delReq("https://t/api/trade-hub/offers?id=1"))).status).toBe(401)
  })
})

describe("/api/trade-hub/offers — success paths", () => {
  it("GET 200s and lists the user's offers", async () => {
    state.user = { id: "u1" }
    state.listData = [{ id: "o1", moment_id: "m1" }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.offers[0].id).toBe("o1")
  })

  it("POST 200s and returns the upserted offer id", async () => {
    state.user = { id: "u1" }
    state.single = { data: { id: "o42" }, error: null }
    const res = await POST(postReq({
      wallet_address: "0xabc", moment_id: "m1", edition_id: "e1", collection_id: "c1",
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.id).toBe("o42")
  })

  it("POST 400s when a required field is missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(postReq({ wallet_address: "0xabc" }))
    expect(res.status).toBe(400)
  })

  it("DELETE 200s when removing by id", async () => {
    state.user = { id: "u1" }
    const res = await DELETE(delReq("https://t/api/trade-hub/offers?id=o1"))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
