import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET/POST /api/cron/alerts-dispatch.
// Fail-closed auth: the handler (run()) checks a Bearer token
// (INGEST_SECRET_TOKEN / CRON_SECRET) before any DB or dispatch work and returns
// 401 on a missing or wrong token. We pin that guard AND drive the real accept:
// the token is read at REQUEST time, the Supabase client is a createClient()
// instance, and the deal/fmv dispatch runs inside after() (stubbed no-op), so
// the immediate 202 { ok, accepted, pipeline } ack is observable with no DB or
// dispatch I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (_fn?: any) => {} }
})
const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "upsert", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
vi.mock("@/lib/alerts", () => ({
  dispatchDueDealAlerts: async () => ({ enqueued: 3 }),
  dispatchTriggeredFmvAlerts: async () => ({ enqueued: 1 }),
}))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/alerts-dispatch"),
  }) as any

import { POST, GET } from "@/app/api/cron/alerts-dispatch/route"

const url = "https://t/api/cron/alerts-dispatch"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/alerts-dispatch", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/alerts-dispatch — success path (immediate ack, dispatch deferred)", () => {
  it("202s and reports { ok, accepted, pipeline } with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("alerts-dispatch")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("alerts-dispatch")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
