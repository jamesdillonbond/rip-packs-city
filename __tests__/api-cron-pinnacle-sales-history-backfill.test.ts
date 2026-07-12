import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/pinnacle-sales-history-backfill (+GET).
// Auth: Bearer/`?token=` against a MODULE-CAPTURED `TOKEN =
// process.env.INGEST_SECRET_TOKEN ?? ""` OR a request-time CRON_SECRET; 401s
// otherwise before any backfill. The full scan does live Flow REST I/O, so the
// 2xx we drive is the two SYNCHRONOUS short-circuit accepts that never touch the
// chain: the kill-switch skip ({skipped:"disabled"}) and the saturation-throttle
// skip ({skipped:"saturation"}), both returning 200 with log_pipeline_run mocked
// inert. Module-load token → two-regime dynamic import for the success case.

const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  // count>15 so the saturation branch trips; disabled branch short-circuits before this read.
  sb.then = (resolve: any) => resolve({ data: [], error: null, count: 20 })
  return { sb }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))

import { POST } from "@/app/api/cron/pinnacle-sales-history-backfill/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-sales-history-backfill"),
  }) as any

const url = "https://t/api/cron/pinnacle-sales-history-backfill"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/pinnacle-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/pinnacle-sales-history-backfill — success path (synchronous skip accepts)", () => {
  const TOKEN = "pinnacle-sales-token"
  let POST2: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/pinnacle-sales-history-backfill/route")
    POST2 = mod.POST as any
  })

  it("200s with skipped:'disabled' when the kill switch is set (Bearer)", async () => {
    process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED = "1"
    try {
      const res = await POST2(makeReq({ url, auth: `Bearer ${TOKEN}` }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.skipped).toBe("disabled")
      expect(body.pipeline).toBe("pinnacle-sales-history-backfill")
    } finally {
      delete process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED
    }
  })

  it("200s with skipped:'saturation' when recent non-self fails exceed the threshold", async () => {
    const res = await POST2(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("saturation")
    expect(body.recent_fails).toBe(20)
  })

  it("kill-switch accept also honors the correct ?token= query param", async () => {
    process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED = "1"
    try {
      const res = await POST2(makeReq({ url, token: TOKEN }))
      expect(res.status).toBe(200)
      expect((await res.json()).skipped).toBe("disabled")
    } finally {
      delete process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED
    }
  })

  it("still 401s with a wrong bearer token under the configured secret", async () => {
    expect((await POST2(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })
})
