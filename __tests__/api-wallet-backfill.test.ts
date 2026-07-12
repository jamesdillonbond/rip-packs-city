import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-backfill. Bearer INGEST_SECRET_TOKEN
// gated → fail-closed 401; a valid token then requires a wallet field (400 on
// bad JSON / missing wallet). The token is read per-request from an unset env
// in-test, so the authed body-guard paths aren't reachable here — only the
// fail-closed 401 is pinned. NOTE: the on-chain Cadence walk runs in after().
// Mocks the FCL shim + supabaseAdmin + helpers to keep the import pure.

vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^0x[a-fA-F0-9]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: async () => ({ found: false }),
}))
vi.mock("@/lib/wallet-backfill-helpers", () => ({
  isStorageLimitError: () => false,
  isNoCollectionCapabilityError: () => false,
}))
vi.mock("@/lib/wallet-backfill-lock", () => ({
  claimPipelineLock: async () => true,
  releasePipelineLock: async () => {},
  walletBackfillLockKey: () => "k",
}))

import { POST } from "@/app/api/wallet-backfill/route"

const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill — fail-closed auth", () => {
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token (expected token unset in-test)", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})
