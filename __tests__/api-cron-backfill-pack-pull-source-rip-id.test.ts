import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/backfill-pack-pull-source-rip-id (GET + POST).
// Data seam: supabaseAdmin from @/lib/supabase. Auth read at REQUEST time —
// authorized() accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET or ?token= and
// 401s otherwise before any backfill. The heavy RPC + log run inside after()
// (stubbed no-op), so the 202 { ok, accepted, pipeline, limit } ack is
// observable without DB I/O; we assert accepted + pipeline + limit.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, so the stub is built inside it (TDZ otherwise).
vi.mock("@/lib/supabase", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({ data: { examined: 10, exact_match: 8, inferred: 1, no_match: 1 }, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { supabaseAdmin: sb, supabase: sb }
})

import { POST, GET } from "@/app/api/cron/backfill-pack-pull-source-rip-id/route"

const url = "https://t/api/cron/backfill-pack-pull-source-rip-id"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

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

describe("POST /api/cron/backfill-pack-pull-source-rip-id", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })
})

describe("POST /api/cron/backfill-pack-pull-source-rip-id — success path (accept, work deferred)", () => {
  it("202s and reports accepted with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("pack-pull-source-rip-id-backfill")
    expect(body.limit).toBe(1000)
  })

  it("202s with the CRON_SECRET bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("202s with a ?token= query param and honors a custom limit", async () => {
    const res = await POST(makeReq({ url: url + "?limit=250", token: "test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).limit).toBe(250)
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
  })
})
