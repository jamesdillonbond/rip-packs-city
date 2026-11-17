import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/resolve-wallet-usernames.
// Auth: Bearer INGEST_SECRET_TOKEN or ?token= (module-const TOKEN, fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: auth is synchronous; the batch of getUserProfile GQL lookups +
// wallet_usernames upserts + pipeline logging are ALL deferred into after(), and
// the route returns an immediate 200 queued ack. after() is stubbed to a no-op so
// the ack is observable without any upstream GQL or DB I/O (supabaseAdmin mocked
// inert). We assert the queued ack envelope (ok + queued + note).

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
  mod = await import("@/app/api/cron/resolve-wallet-usernames/route")
})

describe("POST /api/cron/resolve-wallet-usernames", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/resolve-wallet-usernames — success path", () => {
  it("200-queues with the correct bearer token (resolution deferred to after())", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(true)
    expect(body.note).toContain("wallet-username-resolver")
  })

  it("200-queues via the ?token= query param", async () => {
    const res = await mod.POST(makeReq({ method: "POST", token: "test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).queued).toBe(true)
  })

  it("GET alias reaches the same 200 queued ack when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
  })
})
