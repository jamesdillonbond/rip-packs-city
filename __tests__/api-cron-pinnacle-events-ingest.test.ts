import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/pinnacle-events-ingest (+ GET alias).
// Two-stage fail-closed guard (read at REQUEST time): 500 if INGEST_SECRET_TOKEN
// is unset, else 401 on a missing/wrong Bearer or ?token= before any event
// ingest. Beyond the guard we drive the 200 accept: the chain scan + upsert run
// inside after() (stubbed no-op), so the immediate {ok:true,message:"ingest
// queued"} ack is observable without any Flow REST / proxy / DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { POST, GET } from "@/app/api/cron/pinnacle-events-ingest/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-events-ingest"),
  }) as any

const url = "https://t/api/cron/pinnacle-events-ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("POST /api/cron/pinnacle-events-ingest", () => {
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

describe("POST /api/cron/pinnacle-events-ingest — success path (ingest queued, scan deferred)", () => {
  it("200s and reports 'ingest queued' with the correct bearer token", async () => {
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
    expect((await res.json()).ok).toBe(true)
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("ingest queued")
  })
})
