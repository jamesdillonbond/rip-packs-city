import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/pinnacle/resolve-buyers.
// Auth (call-time, fail-closed): Bearer (?token= retired 2026-11-26) must match INGEST_SECRET_TOKEN
// OR CRON_SECRET, else 401 before any DB work. Happy path pinned at the
// no-work branch (claim RPC returns []) — no Flow REST fetch is exercised.
// claim RPC error -> 500.

const rpcState: { claim: any; calls: number } = { claim: { data: [], error: null }, calls: 0 }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      rpcState.calls++
      if (name === "claim_pinnacle_resolver_batch") return rpcState.claim
      return { data: null, error: null }
    },
  },
}))

import { POST } from "@/app/api/pinnacle/resolve-buyers/route"

const req = (auth?: string, token?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(
      `https://t/api/pinnacle/resolve-buyers${token ? `?token=${token}` : ""}`
    ),
  }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  rpcState.claim = { data: [], error: null }
  rpcState.calls = 0
})

describe("POST /api/pinnacle/resolve-buyers", () => {
  it("401s with no auth header or token", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("returns no_work when the claim batch is empty (Bearer INGEST_SECRET_TOKEN)", async () => {
    const res = await POST(req("Bearer test-ingest-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("no_work")
  })

  it("401s with the correct CRON_SECRET in ?token= — the query form is retired (2026-11-26)", async () => {
    const res = await POST(req(undefined, "test-cron-secret"))
    expect(res.status).toBe(401)
    expect((await res.json()).status).not.toBe("no_work")
    expect(rpcState.calls).toBe(0)
  })

  it("authorizes via Authorization: Bearer against CRON_SECRET", async () => {
    const res = await POST(req("Bearer test-cron-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("no_work")
  })

  it("500s when the claim RPC errors", async () => {
    rpcState.claim = { data: null, error: { message: "claim boom" } }
    const res = await POST(req("Bearer test-ingest-secret"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.reason).toBe("claim_failed")
    expect(body.error).toBe("claim boom")
  })
})
