import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/resolve-topshot-stubs.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET or ?token= (env-gated isAuthed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: auth is synchronous; the edge-fn fetch + pipeline logging are
// deferred into after() and the route returns an immediate 200 trigger ack. after()
// is stubbed to a no-op so the ack is observable without the upstream edge fn or DB
// I/O; supabaseAdmin is mocked inert. We assert the ack envelope (ok + target).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/resolve-topshot-stubs/route")
})

describe("POST /api/cron/resolve-topshot-stubs", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/resolve-topshot-stubs — success path", () => {
  it("200-triggers with the INGEST bearer token (edge-fn call deferred to after())", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.target).toBe("topshot-stub-resolver")
    expect(typeof body.triggered_at).toBe("string")
  })

  it("200-triggers with the CRON_SECRET bearer token too", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("200-triggers via the ?token= query param", async () => {
    const res = await mod.POST(makeReq({ method: "POST", token: "test-ingest-token" }))
    expect(res.status).toBe(200)
  })
})
