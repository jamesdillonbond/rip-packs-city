import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/send-digest. Bearer-gated with
// INGEST_SECRET_TOKEN read into a module-level TOKEN at IMPORT time, so the env
// must be set BEFORE importing the route. Fail-closed: no/wrong header → 401.
// supabaseAdmin (@/lib/supabase) is mocked; happy path uses an empty subscriber
// list so no Resend fetch is made → {subscribers:0, sent:0, errors:0}. Error on
// the subscriber query → 500.

const state: { result: any } = { result: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    is: () => b,
    then: (resolve: any) => resolve(state.result),
  }
  const admin: any = { from: () => b, rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin }
})

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET } = await import("@/app/api/send-digest/route")

function req(auth?: string) {
  const url = "https://t/api/send-digest"
  return { headers: new Headers(auth ? { authorization: auth } : {}), url } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.result = { data: [], error: null }
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("GET /api/send-digest", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong"))).status).toBe(401)
  })

  it("returns a zeroed summary when there are no subscribers", async () => {
    state.result = { data: [], error: null }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ subscribers: 0, sent: 0, errors: 0 })
  })

  it("500s on a subscriber-query error", async () => {
    state.result = { data: null, error: { message: "db down" } }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
