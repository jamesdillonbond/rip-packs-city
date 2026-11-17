import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST/GET /api/cron/golazos-studio-sales-history-backfill.
// POST/GET delegate to lib/studio-sales-history runStudioHistoryDrain, which
// fail-closes on a Bearer check (INGEST_SECRET_TOKEN / CRON_SECRET, or ?token=)
// returning 401 before any drain. The token is read at REQUEST time inside the
// runner, so a top-level import + env-in-beforeEach exercises the success path.
//
// Success path (synchronous 200): with the queue drained the runner logs the
// tick and returns `{ ok:true, note:"queue_empty", pipeline:... }`; the disable
// env short-circuits to `{ ok:true, skipped:"disabled", ... }`. The self-throttle
// read + progress-table pick + log_pipeline_run all hit a chainable Supabase stub
// so the accept is observable without DB I/O.

const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of [
    "from", "select", "eq", "neq", "in", "order", "limit", "gte", "lte", "lt",
    "gt", "is", "not", "or", "range", "match", "insert", "update", "upsert",
    "delete", "returns", "like",
  ]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/golazos-studio-sales-history-backfill"),
  }) as any

import { POST, GET } from "@/app/api/cron/golazos-studio-sales-history-backfill/route"

const url = "https://t/api/cron/golazos-studio-sales-history-backfill"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

afterEach(() => {
  delete process.env.GOLAZOS_STUDIO_SALES_HISTORY_BACKFILL_DISABLED
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/golazos-studio-sales-history-backfill — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/golazos-studio-sales-history-backfill — success path", () => {
  it("200s and reports 'queue_empty' with the INGEST bearer token (empty queue)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("queue_empty")
    expect(body.pipeline).toBe("golazos-studio-sales-history-backfill")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })

  it("short-circuits to skipped:'disabled' when the kill-switch env is set", async () => {
    process.env.GOLAZOS_STUDIO_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("disabled")
  })

  it("GET alias reaches the same 200 queue_empty accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })
})
