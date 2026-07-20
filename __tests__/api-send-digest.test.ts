import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/send-digest. Bearer-gated with
// INGEST_SECRET_TOKEN read into a module-level TOKEN at IMPORT time, so the env
// must be set BEFORE importing the route. Fail-closed: no/wrong header → 401.
// supabaseAdmin (@/lib/supabase) is mocked; happy path uses an empty subscriber
// list so no Resend fetch is made → {subscribers:0, sent:0, errors:0}. Error on
// the subscriber query → 500.

const state: { result: any; rpc: Record<string, any> } = { result: { data: [], error: null }, rpc: {} }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    is: () => b,
    then: (resolve: any) => resolve(state.result),
  }
  const admin: any = {
    from: () => b,
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
  }
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
  state.rpc = {}
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  delete process.env.RESEND_API_KEY
  vi.unstubAllGlobals()
})

// One verified subscriber with a wallet + rich RPC data so buildEmail composes
// portfolio + deals + pulse blocks.
function seedOneSubscriber() {
  state.result = { data: [{ email: "a@b.com", wallet_address: "0xAbC", verification_token: "vt1" }], error: null }
  state.rpc.get_cross_collection_portfolio = { data: { total_fmv: 1234, collection_count: 2, total_moments: 9, total_pnl: 50, collections: [{}, {}] }, error: null }
  state.rpc.get_market_pulse_all = { data: { topshot: { vol: 1 } }, error: null }
  state.rpc.get_cross_collection_deals = { data: { deals: [{ player_name: "Luka", ask_price: 8, discount: 40 }] }, error: null }
}

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

  it("composes + sends a digest via Resend and counts it sent", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }))
    vi.stubGlobal("fetch", fetchSpy as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subscribers: 1, sent: 1, errors: 0 })
    // the Resend call carried the composed HTML
    const firstCall = fetchSpy.mock.calls[0] as any[]
    const callBody = JSON.parse(firstCall[1].body)
    expect(callBody.to).toBe("a@b.com")
    expect(callBody.html).toContain("Weekly Digest")
    expect(callBody.html).toContain("Luka") // deals block
  })

  it("counts an error (does not send) when RESEND_API_KEY is unset", async () => {
    seedOneSubscriber()
    delete process.env.RESEND_API_KEY
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("counts an error on a non-ok Resend response", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, text: async () => "bad" })) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1 })
  })

  it("counts an error when the Resend fetch throws", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network") }) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1 })
  })

  it("handles a subscriber with no wallet (skips the portfolio RPC) and still sends", async () => {
    state.result = { data: [{ email: "c@d.com", wallet_address: null, verification_token: null }], error: null }
    state.rpc.get_market_pulse_all = { data: null, error: null }
    state.rpc.get_cross_collection_deals = { data: { deals: [] }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" })) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 1, errors: 0 })
  })
})
