import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/backfill-edition-names.
// Guard: `if (auth !== "Bearer " + INGEST_SECRET_TOKEN) 401`, read at call time,
// before any Cadence/FCL query. A missing or wrong header 401s. With the correct
// bearer, Step 1's editions query is driven to an empty result (chainable stub
// resolving { data: [], error: null }), so the route short-circuits to its
// no-work 200 accept BEFORE any live Flow Cadence script runs.

// Chainable, thenable stub: from().select().or().filter().limit() awaits to
// { data: [], error: null }; the .rpc/.update seams are inert no-ops.
const sbChain: any = {
  select: () => sbChain,
  or: () => sbChain,
  filter: () => sbChain,
  limit: () => sbChain,
  update: () => sbChain,
  eq: () => sbChain,
  then: (resolve: any) => resolve({ data: [], error: null }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => ({}) } }))

import { POST } from "@/app/api/backfill-edition-names/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill-edition-names", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/backfill-edition-names", () => {
  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("200s with the correct bearer token and no editions to fill", async () => {
    const res = await POST(req("Bearer " + TOKEN))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.updated).toBe(0)
    expect(body.failed).toBe(0)
    expect(body.remaining).toBe(0)
  })
})
