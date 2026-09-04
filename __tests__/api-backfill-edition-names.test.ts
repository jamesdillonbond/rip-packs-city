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
// 2026-09-03: `failCount` makes ONLY the head:true count read fail (supabase-js
// returns errors, so a failed count is `{ count: null, error }`), leaving Step 1's
// row read on the empty path — the shape that used to publish `remaining: 0`.
const failState = { failCount: false, lastHead: false }
const sbChain: any = {
  select: (_cols?: unknown, opts?: { head?: boolean }) => { failState.lastHead = opts?.head === true; return sbChain },
  or: () => sbChain,
  filter: () => sbChain,
  limit: () => sbChain,
  update: () => sbChain,
  eq: () => sbChain,
  then: (resolve: any) =>
    resolve(
      failState.failCount && failState.lastHead
        ? { data: null, count: null, error: { message: "canceling statement due to statement timeout" } }
        : failState.failCount
          // one stub so the route reaches Step 4 (the row read itself is healthy)
          ? { data: [{ id: "e1", external_id: "1:2", name: "Stub", tier: "COMMON", series: 1 }], error: null }
          : { data: [], error: null },
    ),
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

// ── 2026-09-03: a failed remaining-count is unknown, not "done" ──────────────
//
// `remaining` is a completion signal — 0 reads as "the backfill is finished".
// The old `remaining ?? 0` published exactly that off a count that failed.
describe("POST /api/backfill-edition-names — a failed remaining count is null, never 0", () => {
  beforeEach(() => { failState.failCount = true; failState.lastHead = false })
  afterEach(() => { failState.failCount = false })

  it("answers remaining: null with the error named, instead of claiming nothing is left", async () => {
    const res = await POST(req("Bearer " + TOKEN))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.remaining).toBeNull()
    expect(body.remaining).not.toBe(0)
    expect(String(body.remaining_error)).toContain("statement timeout")
  })
})
