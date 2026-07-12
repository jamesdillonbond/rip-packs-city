import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/resolve-topshot-username.
// Auth is a CALL-TIME Bearer check: `if (!expected || authHeader !== Bearer …)`
// → 401. Because the unset-secret branch collapses into the same 401 (via
// `!expected`), an unset INGEST_SECRET_TOKEN is 401, NOT 500. We pin unset /
// wrong / missing → 401, then the body guards (400), then a mocked found path.

const resolveState: { outcome: any } = { outcome: { found: false, reason: "not_found" } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => resolveState.outcome,
}))

import { POST } from "@/app/api/resolve-topshot-username/route"

const TOKEN = "test-ingest-secret"

function req(opts: { auth?: string; body?: any; badJson?: boolean }) {
  return {
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
    json: async () => {
      if (opts.badJson) throw new Error("bad json")
      return opts.body ?? {}
    },
  } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  resolveState.outcome = { found: false, reason: "not_found" }
})

describe("POST /api/resolve-topshot-username", () => {
  it("401s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req({ auth: "Bearer whatever" }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req({ auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req({}))).status).toBe(401)
  })

  it("400s on an invalid JSON body", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json_body")
  })

  it("400s when username is empty", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, body: { username: "   " } }))
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe("username_required")
  })

  it("returns the resolved wallet on a found outcome", async () => {
    resolveState.outcome = {
      found: true,
      walletAddress: "0xabc",
      username: "someone",
      source: "seeded_wallets",
      cacheLayer: "seeded_wallets",
    }
    const res = await POST(req({ auth: `Bearer ${TOKEN}`, body: { username: "someone" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.wallet_address).toBe("0xabc")
    expect(body.cache_layer).toBe("seeded_wallets")
  })
})
