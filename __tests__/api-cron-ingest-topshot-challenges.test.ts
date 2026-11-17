import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for the Top Shot challenge-ingest cron. Three branches:
//   - unauthorized (no/incorrect Bearer)            → 401
//   - authorized but feature-flag off               → 200 { status: "disabled" }
//   - authorized + enabled                          → 202 { status: "accepted" } (work deferred to after())
// after() is stubbed to a no-op so the deferred body doesn't run in the suite;
// the ingest lib is mocked so no live proxy/DB call is attempted. A hoisted
// holder toggles the feature flag per test.

const h = vi.hoisted(() => ({ enabled: false }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
}))

vi.mock("@/lib/challenges/topshot-ingest", () => ({
  challengeIngestEnabled: () => h.enabled,
  ingestTopshotChallenges: async () => ({ fetched: 0, upserted: 0, skipped: 0 }),
}))

const { GET, POST } = await import("@/app/api/cron/ingest-topshot-challenges/route")

process.env.CRON_SECRET = "cron-secret"

function req(auth?: string, method: "GET" | "POST" = "GET"): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/cron/ingest-topshot-challenges", { method, headers })
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret"
  h.enabled = false
})

describe("GET/POST /api/cron/ingest-topshot-challenges", () => {
  it("401s without a valid Bearer token", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong Bearer token", async () => {
    const res = await GET(req("Bearer nope"))
    expect(res.status).toBe(401)
  })

  it("200 'disabled' when authorized but the feature flag is off", async () => {
    const res = await GET(req("Bearer cron-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("disabled")
  })

  it("202 'accepted' when authorized and enabled (work deferred)", async () => {
    h.enabled = true
    const res = await GET(req("Bearer cron-secret"))
    expect(res.status).toBe(202)
    expect((await res.json()).status).toBe("accepted")
  })

  it("also accepts the INGEST_SECRET_TOKEN Bearer on the POST path", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-token"
    h.enabled = true
    const res = await POST(req("Bearer ingest-token", "POST"))
    expect(res.status).toBe(202)
    delete process.env.INGEST_SECRET_TOKEN
  })
})
