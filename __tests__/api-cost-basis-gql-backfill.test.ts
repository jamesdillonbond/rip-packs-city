import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/cost-basis-gql-backfill.
// PRIORITY = fail-closed Bearer auth (INGEST_SECRET_TOKEN, read into a
// module-level const at import time → set env before the dynamic import and
// never static-import). fcl (@/lib/flow) is mocked to return no owned IDs so
// the authed happy path returns done:true with no GQL/Supabase I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"

const fclState: { owned: any } = { owned: [] }

vi.mock("@/lib/chains/flow/flow", () => ({
  default: { query: async () => fclState.owned },
}))
vi.mock("@onflow/types", () => ({ Address: "Address" }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
}))

const AUTH = "Bearer test-ingest-secret"

function req(opts: { auth?: string; body?: any } = {}): any {
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return { method: "POST", headers, json: async () => opts.body ?? {} }
}

async function loadPOST() {
  return (await import("@/app/api/cost-basis-gql-backfill/route")).POST
}

beforeEach(() => {
  fclState.owned = []
})

describe("POST /api/cost-basis-gql-backfill", () => {
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
    const res = await POST(req({ auth: AUTH, body: { wallet: "xyz" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("16-char hex")
  })

  it("returns done:true when the wallet owns no moments", async () => {
    fclState.owned = []
    const POST = await loadPOST()
    const res = await POST(req({ auth: AUTH, body: { wallet: "0xabcdef0123456789" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.done).toBe(true)
    expect(body.total).toBe(0)
  })
})
