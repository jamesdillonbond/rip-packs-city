import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/subscribe/unsubscribe. Token-gated HTML
// endpoint: no token → 400, a successful email_subscribers update → 200, and a
// DB error → 500. Mocks supabaseAdmin's .from().update().eq() chain.

const state: { error: any } = { error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    update: () => b,
    eq: async () => ({ error: state.error }),
  }
  return { supabaseAdmin: { from: () => b }, supabase: { from: () => b } }
})

import { GET } from "@/app/api/subscribe/unsubscribe/route"

const req = (u: string) => ({ nextUrl: new URL(u), url: u }) as any

beforeEach(() => { state.error = null })

describe("GET /api/subscribe/unsubscribe", () => {
  it("400s without a token", async () => {
    const res = await GET(req("https://t/api/subscribe/unsubscribe"))
    expect(res.status).toBe(400)
    expect(res.headers.get("Content-Type")).toContain("text/html")
  })

  it("200s on a successful unsubscribe", async () => {
    const res = await GET(req("https://t/api/subscribe/unsubscribe?token=abc"))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("unsubscribed")
  })

  it("500s when the update errors", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/subscribe/unsubscribe?token=abc"))
    expect(res.status).toBe(500)
  })
})
