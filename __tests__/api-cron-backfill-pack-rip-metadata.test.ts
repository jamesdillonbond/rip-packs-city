import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/backfill-pack-rip-metadata (GET + POST).
// Data seam: createClient from @supabase/supabase-js at module top. Auth read
// at REQUEST time — requires Bearer INGEST_SECRET_TOKEN exactly, 401s otherwise
// before running backfill_pack_rip_metadata. The RPC + log_pipeline_run run
// inside after() (stubbed no-op), so the 202 { ok, accepted, pipeline } ack is
// observable without DB I/O; we assert accepted + pipeline.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, and the route calls createClient() at module load (TDZ otherwise).
vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({ data: { processed: 500, dist_resolved: 300, value_resolved: 250 }, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { createClient: () => sb }
})

import { POST, GET } from "@/app/api/cron/backfill-pack-rip-metadata/route"

const url = "https://t/api/cron/backfill-pack-rip-metadata"
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

describe("POST /api/cron/backfill-pack-rip-metadata", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })
})

describe("POST /api/cron/backfill-pack-rip-metadata — success path (accept, work deferred)", () => {
  it("202s and reports accepted with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("backfill-pack-rip-metadata")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
