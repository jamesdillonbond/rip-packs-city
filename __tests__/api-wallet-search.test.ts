import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-search. Pins the pre-resolution
// guards that fire before any Flow/GraphQL/DB call (malformed JSON / missing
// input / unknown collection / per-collection redirects) AND the 2xx success
// paths that ARE cleanly reachable: the Flow-EVM soft-recognition 200, the
// Golazos "coming soon" 200, and the Top-Shot walk 200 for a wallet that owns
// nothing (fcl mocked to return no ids → empty rows). The heavy on-chain walk +
// enrichment for a populated wallet needs live Cadence/GQL and is left
// uncovered. Mocks the FCL shim, TopShot GQL, supabaseAdmin, auth + rewards so
// the import + happy path are pure.

vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))

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
  it("400s and redirects UFC lookups to /api/ufc-wallet-scan", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac", collection: "ufc" }))
    expect(res.status).toBe(400)
    expect((await res.json()).redirect).toBe("/api/ufc-wallet-scan")
  })
})

describe("POST /api/wallet-search — 2xx success paths", () => {
  it("200s with a soft-recognition notice for a Flow-EVM (40-hex) address", async () => {
    const res = await POST(req({ input: "0x1234567890abcdef1234567890abcdef12345678" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toContain("Flow EVM")
    expect(body.rows).toEqual([])
  })

  it("200s with a 'coming soon' notice for Golazos lookups", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac", collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toContain("coming soon")
    expect(body.rows).toEqual([])
  })

  it("200s with an empty result set for a Top-Shot wallet that owns no moments", async () => {
    const res = await POST(req({ input: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.walletAddress).toBe("0xbd94cade097e50ac")
    expect(body.summary.totalMoments).toBe(0)
    expect(body.summary.returnedMoments).toBe(0)
  })
})
