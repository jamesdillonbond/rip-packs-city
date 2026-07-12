import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET/POST /api/cron/allday-studio-sales-history-backfill.
// The POST/GET handlers delegate to lib/studio-sales-history runStudioHistoryDrain,
// whose first step is a fail-closed Bearer check (INGEST_SECRET_TOKEN /
// CRON_SECRET, or ?token=) read at REQUEST time, returning 401 before any drain.
// We pin that guard AND drive the real 2xx accepts by stubbing the lib's data seam
// (supabaseAdmin from @/lib/supabase — chainable). With no pending targets the
// drain returns 200 { ok, note:"queue_empty", pipeline }; the kill-switch env
// returns 200 { ok, skipped:"disabled", pipeline }; ?seed=true returns 200
// { ok, mode:"seed", seeded }. None of these paths hit the studio GQL fetch.

const PIPELINE = "allday-studio-sales-history-backfill"

const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: 0, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

const url = "https://t/api/cron/allday-studio-sales-history-backfill"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(url),
  }) as any

import { POST, GET } from "@/app/api/cron/allday-studio-sales-history-backfill/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  delete process.env.ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED
})

describe("POST /api/cron/allday-studio-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/allday-studio-sales-history-backfill — success path (no external I/O)", () => {
  it("200s with note:queue_empty when no targets are pending (INGEST bearer)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("queue_empty")
    expect(body.pipeline).toBe(PIPELINE)
  })

  it("also accepts CRON_SECRET as the bearer token (queue_empty)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })

  it("200s with skipped:disabled when the kill-switch env is set", async () => {
    process.env.ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("disabled")
    expect(body.pipeline).toBe(PIPELINE)
  })

  it("200s with mode:seed when ?seed=true (mocked seed RPC)", async () => {
    const res = await POST(makeReq({ url: `${url}?seed=true`, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mode).toBe("seed")
    expect(body.seeded).toBe(0)
  })

  it("GET alias reaches the same 200 queue_empty accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })
})
