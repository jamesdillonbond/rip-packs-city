import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/cost-basis-backfill.
// PRIORITY = fail-closed Bearer auth (INGEST_SECRET_TOKEN). The token is read
// into a module-level const at import time, so we set process.env BEFORE the
// dynamic import below and never statically import the route. fcl (@/lib/flow)
// and @onflow/types are mocked so the Cadence query returns no owned IDs — the
// authed happy path then short-circuits to the "no owned moments" response
// without touching Supabase.

process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"

const fclState: { owned: any } = { owned: [] }

vi.mock("@/lib/chains/flow/flow", () => ({
  default: { query: async () => fclState.owned },
}))
vi.mock("@onflow/types", () => ({ Address: "Address" }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
}))

const AUTH = "Bearer test-ingest-secret"

function req(opts: { auth?: string; body?: any } = {}): any {
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return {
    method: "POST",
    headers,
    json: async () => opts.body ?? {},
  }
}

async function loadPOST() {
  return (await import("@/app/api/cost-basis-backfill/route")).POST
}

beforeEach(() => {
  fclState.owned = []
})

describe("POST /api/cost-basis-backfill", () => {
  it("401s with no Authorization header", async () => {
    const POST = await loadPOST()
    const res = await POST(req({ body: { wallet: "0xabcdef0123456789" } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const POST = await loadPOST()
    const res = await POST(req({ auth: "Bearer nope", body: { wallet: "0xabcdef0123456789" } }))
    expect(res.status).toBe(401)
  })

  it("400s on a malformed wallet even when authed", async () => {
    const POST = await loadPOST()
    const res = await POST(req({ auth: AUTH, body: { wallet: "not-a-wallet" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("16-char hex")
  })

  it("returns a zeroed result when the wallet owns no moments", async () => {
    fclState.owned = []
    const POST = await loadPOST()
    const res = await POST(req({ auth: AUTH, body: { wallet: "0xabcdef0123456789" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toBe("No owned moments found")
    expect(body.result.total_ids).toBe(0)
  })
})
