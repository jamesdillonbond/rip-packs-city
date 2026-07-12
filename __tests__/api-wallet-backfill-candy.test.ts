import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill-candy (Solana/Candy).
// Bearer INGEST_SECRET_TOKEN gated → fail-closed 401. Once authed the route
// validates a base58 wallet (400 otherwise), then either short-circuits to a
// discovery-pending 202 (INERT until CANDY_MLB_COLLECTION_ADDRESS is filled) or,
// when discovery is ready, returns the fire-and-forget accept 202 with the DAS
// walk deferred to after() (stubbed no-op). candyDiscoveryReady is mocked via a
// hoisted flag so both 202 shapes are covered. Mocks supabaseAdmin + the Solana
// DAS/normalize libs.

const state = vi.hoisted(() => ({ ready: false }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/chains/solana/das", () => ({ paginateOwner: async () => {} }))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_COLLECTION_ADDRESS: "TODO_1_CANDY_CORE_COLLECTION_ADDRESS",
  CANDY_MLB_SLUG: "candy_mlb",
  candyDiscoveryReady: () => state.ready,
  normalizeSerial: () => ({ moment_id: null }),
}))

import { POST } from "@/app/api/wallet-backfill-candy/route"

const url = "https://t/api/wallet-backfill-candy"
const VALID_SOL = "So11111111111111111111111111111111111111112"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill-candy — fail-closed auth", () => {
  beforeEach(() => { delete process.env.INGEST_SECRET_TOKEN })
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})

describe("POST /api/wallet-backfill-candy — secret configured (success + body guards)", () => {
  const TOKEN = "test-ingest-secret"
  beforeEach(() => { process.env.INGEST_SECRET_TOKEN = TOKEN; state.ready = false })
  afterEach(() => { delete process.env.INGEST_SECRET_TOKEN; state.ready = false })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong", body: { wallet: VALID_SOL } }))).status).toBe(401)
  })

  it("400s on malformed JSON when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s on a missing wallet field when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet field required")
  })

  it("400s on a non-base58 (Flow 0x) wallet when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet is not a base58 Solana address")
  })

  it("202 discovery-pending short-circuit while discovery is not ready", async () => {
    state.ready = false
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: VALID_SOL } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("discovery_pending")
    expect(body.collection).toBe("candy_mlb")
  })

  it("202-accepts once discovery is ready (DAS walk deferred to after())", async () => {
    state.ready = true
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: VALID_SOL } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("candy_mlb")
    expect(body.wallet_address).toBe(VALID_SOL)
  })
})
