import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET/POST /api/cron/allday-sales-history-backfill.
// Auth: module-level `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` (captured at
// import) OR request-time CRON_SECRET, both also accepted as ?token=. The handler
// is SYNCHRONOUS (no after()). We pin the guard AND drive two real 2xx accepts via
// the two-regime resetModules pattern with the secret SET at import:
//   • kill-switch: env ALLDAY_SALES_HISTORY_BACKFILL_DISABLED=1 → 200
//     { ok, skipped:"disabled", pipeline } (returns before any I/O).
//   • full tick: chainable Supabase stub (null cursor → default ceiling, empty
//     scan) + a global-fetch stub returning [] for the Flow REST event ranges
//     (range=250 → a single chunk) → the genuine 200 { ok, pipeline, found:0,
//     sales_written:0, unmapped_written:0, below_floor:false }.

const PIPELINE = "allday-sales-history-backfill"

const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateAllDayEditions: async () => [],
  toUpsertRow: () => ({}),
}))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async () => ({ buyer: null, seller: null, priceDuc: null, priceCertain: false, priceReason: "", sampleAmounts: [] }),
}))

const url = "https://t/api/cron/allday-sales-history-backfill"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(url),
  }) as any

import { POST } from "@/app/api/cron/allday-sales-history-backfill/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/allday-sales-history-backfill — secret configured (success path)", () => {
  const TOKEN = "allday-history-ingest-token"
  let POST2: (req: any) => Promise<Response>
  let GET2: (req: any) => Promise<Response>
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    delete process.env.CRON_SECRET
    delete process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED
    // Inert Flow REST responses so the on-chain scan reads zero events.
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "" })) as any
    const mod = await import("@/app/api/cron/allday-sales-history-backfill/route")
    POST2 = mod.POST as any
    GET2 = mod.GET as any
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    delete process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST2(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200s with skipped:disabled when the kill-switch env is set", async () => {
    process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST2(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("disabled")
    expect(body.pipeline).toBe(PIPELINE)
    delete process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED
  })

  it("200s and reports a genuine empty tick with the correct bearer token", async () => {
    const res = await POST2(makeReq({ url: `${url}?range=250`, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pipeline).toBe(PIPELINE)
    expect(body.found).toBe(0)
    expect(body.sales_written).toBe(0)
    expect(body.unmapped_written).toBe(0)
    expect(body.below_floor).toBe(false)
  })

  it("200s via the correct ?token= query param (GET alias, empty tick)", async () => {
    const res = await GET2(makeReq({ url: `${url}?range=250`, method: "GET", token: TOKEN }))
    expect(res.status).toBe(200)
    expect((await res.json()).pipeline).toBe(PIPELINE)
  })
})
