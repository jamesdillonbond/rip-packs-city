import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill-allday. Bearer
// INGEST_SECRET_TOKEN gated → fail-closed 401. The AllDay Cadence walk runs in
// after() (stubbed no-op) so the default fire-and-forget accept (202) is
// observable. resolveWalletInput short-circuits for a valid 0x address, so no
// network is touched. Sync-mode is left uncovered (it drives the real
// runAllDayDetailsBackfill inline, which needs live Cadence). Mocks
// supabaseAdmin + wallet-backfill-helpers.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isStorageLimitError: () => false,
  isNoCollectionCapabilityError: () => false,
}))

import { POST } from "@/app/api/wallet-backfill-allday/route"

const url = "https://t/api/wallet-backfill-allday"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill-allday — fail-closed auth", () => {
  beforeEach(() => { delete process.env.INGEST_SECRET_TOKEN })
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})

describe("POST /api/wallet-backfill-allday — secret configured (success + body guards)", () => {
  const TOKEN = "test-ingest-secret"
  beforeEach(() => { process.env.INGEST_SECRET_TOKEN = TOKEN })
  afterEach(() => { delete process.env.INGEST_SECRET_TOKEN })

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

  it("202-accepts with the correct bearer token + a valid wallet (walk deferred to after())", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("nfl_all_day")
    expect(body.wallet_address).toBe("0xbd94cade097e50ac")
    expect(body.skip_cached).toBe(true)
  })
})
