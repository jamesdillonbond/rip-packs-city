import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/pinnacle-studio-sales-history-backfill.
// Fail-closed auth (read at REQUEST time): Bearer/`?token=` against
// INGEST_SECRET_TOKEN / CRON_SECRET, 401ing otherwise before any drain. The
// render drain does live studio-platform GQL I/O, so the 2xx we drive is the two
// SYNCHRONOUS accepts that never reach the GQL: the kill-switch skip
// ({skipped:"disabled"}) and the empty-queue accept ({note:"queue_empty"}) —
// the latter passes the saturation throttle (count 0) then finds no pending
// renders. log_pipeline_run is mocked inert. Token is request-time, so the
// top-level import + env-in-beforeEach regime is sufficient.

const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  // count 0 → passes the saturation throttle; data [] → no pending renders (queue_empty).
  sb.then = (resolve: any) => resolve({ data: [], error: null, count: 0 })
  return { sb }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { POST } from "@/app/api/cron/pinnacle-studio-sales-history-backfill/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-studio-sales-history-backfill"),
  }) as any

const url = "https://t/api/cron/pinnacle-studio-sales-history-backfill"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/pinnacle-studio-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/pinnacle-studio-sales-history-backfill — success path (synchronous skip accepts)", () => {
  it("200s with note:'queue_empty' when no pending renders remain (Bearer)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("queue_empty")
    expect(body.pipeline).toBe("pinnacle-studio-sales-history-backfill")
  })

  it("also accepts CRON_SECRET as the bearer token (still queue_empty)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })

  it("200s with skipped:'disabled' when the kill switch is set", async () => {
    process.env.PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED = "1"
    try {
      const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.skipped).toBe("disabled")
      expect(body.pipeline).toBe("pinnacle-studio-sales-history-backfill")
    } finally {
      delete process.env.PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED
    }
  })
})
