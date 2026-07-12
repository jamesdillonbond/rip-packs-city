import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/pinnacle-listings-retry (POST + GET alias).
// Bearer/?token auth against a MODULE-LEVEL TOKEN const (INGEST_SECRET_TOKEN)
// read at import time — env set BEFORE import; fail-closed 401 when unset. The
// queue drain runs inside after(), stubbed to a no-op so the immediate 200
// ("retry queued") is observable. We pin the 401s and the authed 200; the
// deferred drain (Flow REST + DB) is not driven.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { POST, GET } = await import("@/app/api/pinnacle-listings-retry/route")

const req = (opts: { auth?: string; token?: string }) =>
  ({
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
    nextUrl: new URL(
      opts.token
        ? `https://t/api/pinnacle-listings-retry?token=${opts.token}`
        : "https://t/api/pinnacle-listings-retry"
    ),
  }) as any

describe("POST /api/pinnacle-listings-retry", () => {
  it("401s with no authorization", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req({ auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200s and queues the retry with the matching bearer token", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("retry queued")
  })

  it("200s with a matching ?token= query param", async () => {
    expect((await POST(req({ token: TOKEN }))).status).toBe(200)
  })
})

describe("GET /api/pinnacle-listings-retry", () => {
  it("delegates to POST (401 without auth)", async () => {
    expect((await GET(req({}))).status).toBe(401)
  })
})
