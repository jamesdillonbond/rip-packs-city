import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/lock-check-batch.
// Fail-closed auth: the POST handler compares the Bearer token to a
// module-captured `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` and 401s on a
// missing/wrong credential (also when unset, via `!TOKEN`) before anything runs.
//
// Success path (immediate 202 ack): the Cadence lock-check batch is fire-and-
// forget inside after() — stubbed to a no-op — so the route returns
// `{ accepted:true, pipeline:"lock-check-batch" }` (202) with no Flow REST / DB
// I/O. Token is MODULE-LOAD captured, so the accept uses a two-regime dynamic
// import with the secret set before import.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of [
    "from", "select", "eq", "neq", "in", "order", "limit", "gte", "lte", "lt",
    "gt", "is", "not", "or", "range", "match", "insert", "update", "upsert",
    "delete", "returns",
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
    nextUrl: new URL("https://t/api/cron/lock-check-batch"),
  }) as any

import { POST } from "@/app/api/cron/lock-check-batch/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/lock-check-batch — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/lock-check-batch — success path (immediate 202 ack)", () => {
  const TOKEN = "lock-check-ingest-token"
  const url = "https://t/api/cron/lock-check-batch"
  const savedIngest = process.env.INGEST_SECRET_TOKEN
  let SPOST: (req: any) => Promise<Response>

  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/lock-check-batch/route")
    SPOST = mod.POST as any
  })

  afterAll(() => {
    if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
    else process.env.INGEST_SECRET_TOKEN = savedIngest
  })

  it("still 401s with a wrong bearer token when the secret is configured", async () => {
    expect((await SPOST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("202s and reports accepted:true / pipeline with the correct bearer token", async () => {
    const res = await SPOST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("lock-check-batch")
  })
})
