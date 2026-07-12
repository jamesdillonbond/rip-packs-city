import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/compute-laliga-pack-ev.
// Fail-closed auth: the handler accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// (or ?token=) and 401s otherwise before computing Golazos pack EV. We pin that,
// then drive the real 200 accept. Token is read at REQUEST time; the pack-EV
// sweep runs inside after() (stubbed no-op) so the immediate ack is observable
// without pool/RPC/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "insert", "delete"]) s[m] = () => s
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { POST, GET } from "@/app/api/cron/compute-laliga-pack-ev/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/compute-laliga-pack-ev"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET
const url = "https://t/api/cron/compute-laliga-pack-ev"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/compute-laliga-pack-ev — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/compute-laliga-pack-ev — success path (immediate ack, sweep deferred)", () => {
  it("200s and reports 'compute-laliga-pack-ev triggered' with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("compute-laliga-pack-ev triggered")
    expect(typeof body.triggered_at).toBe("string")
  })

  it("also accepts the CRON_SECRET bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("compute-laliga-pack-ev triggered")
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
