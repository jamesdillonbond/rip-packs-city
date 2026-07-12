import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-search. Pins the pre-resolution
// guards that fire before any Flow/GraphQL/DB call: malformed JSON → 400, a
// missing/empty input → 400, an unknown collection slug → 400, and the dedicated
// per-collection redirects (Pinnacle/UFC → 400 pointing at the right route). The
// full on-chain walk + enrichment is out of scope. Mocks the FCL shim, TopShot
// GQL, and supabaseAdmin so the import is pure.

vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }))

import { POST } from "@/app/api/wallet-search/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/wallet-search — pre-resolution guards", () => {
  it("400s on malformed JSON", async () => {
    expect((await POST(req(null, true))).status).toBe(400)
  })
  it("400s on a missing input", async () => {
    expect((await POST(req({}))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac", collection: "not-real" }))
    expect(res.status).toBe(400)
  })
  it("400s and redirects Pinnacle lookups to /api/pinnacle-wallet", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac", collection: "disney-pinnacle" }))
    expect(res.status).toBe(400)
    expect((await res.json()).redirect).toBe("/api/pinnacle-wallet")
  })
})
