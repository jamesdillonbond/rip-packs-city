import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/evm-transfers-ingest (+ GET alias).
// Two-stage fail-closed guard (read at REQUEST time): 500 if INGEST_SECRET_TOKEN
// is unset (server misconfigured), else 401 on a missing/wrong Bearer or ?token=
// before any ingest. The heavy EVM block-scan runs inside after() (stubbed
// no-op) — the evm-rpc log walk is deferred — so the "ingest queued" ack is
// observable without any getLogs/DB I/O. We pin both guards, then drive the 200.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "insert", "update", "upsert", "maybeSingle"]) s[m] = () => s
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/evm-rpc", () => ({
  getLogs: async () => [],
  getBlockByNumber: async () => null,
}))

import { POST, GET } from "@/app/api/cron/evm-transfers-ingest/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/evm-transfers-ingest"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const url = "https://t/api/cron/evm-transfers-ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("POST /api/cron/evm-transfers-ingest — auth guards", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req("Bearer whatever"))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})

describe("POST /api/cron/evm-transfers-ingest — success path (immediate ack, scan deferred)", () => {
  it("200s and reports 'ingest queued' with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("ingest queued")
    expect(typeof body.started_at).toBe("string")
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("ingest queued")
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
