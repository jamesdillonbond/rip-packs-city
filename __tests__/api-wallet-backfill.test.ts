import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill. Bearer INGEST_SECRET_TOKEN
// gated → fail-closed 401; a valid token then requires a wallet field (400 on
// bad JSON / missing wallet / unresolvable username) before the on-chain Cadence
// walk (which runs in after(), stubbed no-op here) fires. The token is read
// per-request from process.env, so both regimes are exercised by toggling the
// env var — no vi.resetModules needed. Mocks the FCL shim + supabaseAdmin +
// helpers + the pipeline lock so the accept (202) is observable without I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^0x[a-fA-F0-9]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: async () => ({ found: false }),
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  isStorageLimitError: () => false,
  isNoCollectionCapabilityError: () => false,
}))
vi.mock("@/lib/wallet-backfill-lock", () => ({
  claimPipelineLock: async () => true,
  claimPipelineLockDetailed: async () => ({ claimed: true, reason: "claimed" }),
  skippedReasonFor: () => "skipped_in_progress",
  releasePipelineLock: async () => {},
  walletBackfillLockKey: () => "k",
}))

import { POST } from "@/app/api/wallet-backfill/route"

const url = "https://t/api/wallet-backfill"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill — fail-closed auth", () => {
  beforeEach(() => { delete process.env.INGEST_SECRET_TOKEN })
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token (expected token unset in-test)", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})

describe("POST /api/wallet-backfill — secret configured (success + body guards)", () => {
  const TOKEN = "test-ingest-secret"
  beforeEach(() => { process.env.INGEST_SECRET_TOKEN = TOKEN })
  afterEach(() => { delete process.env.INGEST_SECRET_TOKEN })

  it("still 401s with no token", async () => {
    expect((await POST(makeReq({ url, body: { wallet: "0xbd94cade097e50ac" } }))).status).toBe(401)
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong", body: { wallet: "0xbd94cade097e50ac" } }))).status).toBe(401)
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

  it("400s when a username cannot be resolved", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "nonexistentuser" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("could not resolve username")
  })

  it("202-accepts with the correct bearer token + a valid wallet (walk deferred to after())", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.wallet_address).toBe("0xbd94cade097e50ac")
    expect(body.skip_cached).toBe(true)
    expect(typeof body.started_at).toBe("string")
  })
})
