import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/cadence-payer-balance-check (GET + POST).
// Data seam: supabaseAdmin from @/lib/supabase (log_pipeline_run RPC, stubbed
// inert). Auth read at REQUEST time — authorized() accepts Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET or ?token=, 401ing otherwise. The 200
// success reads the payer FLOW balance via a raw fetch to Flow REST; we stub
// global fetch to return a healthy UFix64 balance so the sync body
// { ok, payer_address, balance_flow, threshold_flow } is observable, and assert
// the balance the route derives (5000000000 / 1e8 = 50 FLOW).

// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, so the stub is built inside it (TDZ otherwise).
vi.mock("@/lib/supabase", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { supabaseAdmin: sb, supabase: sb }
})

import { POST, GET } from "@/app/api/cron/cadence-payer-balance-check/route"

const url = "https://t/api/cron/cadence-payer-balance-check"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ balance: "5000000000" }),
      text: async () => "",
    })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/cadence-payer-balance-check", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })
})

describe("POST /api/cron/cadence-payer-balance-check — success path", () => {
  it("200s and reports the parsed payer balance with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.payer_address).toBe("0x73f55c4450b8d466")
    expect(body.balance_flow).toBe(50)
    expect(body.threshold_flow).toBe(0.05)
  })

  it("200s with the CRON_SECRET bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).payer_address).toBe("0x73f55c4450b8d466")
  })

  it("200s with a ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).balance_flow).toBe(50)
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
  })
})
