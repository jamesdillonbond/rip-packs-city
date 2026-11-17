import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill-multicollection. Bearer
// INGEST_SECRET_TOKEN gated → fail-closed 401. The per-collection fan-out (via
// fetch to the sibling backfill routes) + telemetry writes run in after()
// (stubbed no-op), so the immediate 202 accept is observable without any
// outbound fetch or DB I/O. Mocks supabaseAdmin.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))

import { POST } from "@/app/api/wallet-backfill-multicollection/route"

const url = "https://t/api/wallet-backfill-multicollection"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body, url }) as any

describe("POST /api/wallet-backfill-multicollection — fail-closed auth", () => {
  beforeEach(() => { delete process.env.INGEST_SECRET_TOKEN })
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})

describe("POST /api/wallet-backfill-multicollection — secret configured (success + body guards)", () => {
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

  it("202-accepts with the correct bearer token + a valid wallet (fan-out deferred to after())", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.wallet_address).toBe("0xbd94cade097e50ac")
    expect(body.accepted_count).toBe(5)
    expect(body.collection_count).toBe(5)
    expect(body.sync_collections).toEqual(["nfl_all_day", "disney_pinnacle"])
    expect(body.fire_and_forget_collections).toEqual(["nba_top_shot", "laliga_golazos", "ufc_strike"])
  })
})
