import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/allow-list-reconcile (GET + POST).
// Data seam: createClient from @supabase/supabase-js at module top. Auth is
// read at REQUEST time — 500 ({ error: "Server misconfigured..." }) if
// INGEST_SECRET_TOKEN is unset, else 401 on a missing/wrong Bearer token
// before the reconcile RPC. The 200 success surfaces reconcile_allow_list_prewarm()'s
// result verbatim under { ok: true, ...result }. Beyond the happy path this pins
// the RPC-error 500, the skipped_count>0 warn branch, the fatal-catch 500 when
// the RPC throws, and the alternate CRON_SECRET bearer accepted by Vercel Cron.

// rpc behaviour is state-driven so error / throw / alternate-result branches are
// reachable per test. Factory is self-contained (vi.mock is hoisted).
const rpcState = vi.hoisted(() => ({
  result: { data: null as any, error: null as any },
  throwErr: false,
}))

vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => {
    if (rpcState.throwErr) throw new Error("rpc exploded")
    return rpcState.result
  }
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { createClient: () => sb }
})

import { POST, GET } from "@/app/api/cron/allow-list-reconcile/route"

const url = "https://t/api/cron/allow-list-reconcile"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

const OK_RESULT = {
  ran_at: "2026-07-12T00:00:00.000Z",
  promoted_count: 2,
  skipped_count: 0,
  promoted_emails: ["a@example.com", "b@example.com"],
  skipped_detail: [],
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  delete process.env.CRON_SECRET
  rpcState.result = { data: { ...OK_RESULT }, error: null }
  rpcState.throwErr = false
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/allow-list-reconcile", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(makeReq({ url, auth: "Bearer whatever" }))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })
})

describe("POST /api/cron/allow-list-reconcile — success path", () => {
  it("200s and surfaces the reconcile result with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.promoted_count).toBe(2)
    expect(body.promoted_emails).toEqual(["a@example.com", "b@example.com"])
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).promoted_count).toBe(2)
  })

  it("accepts the alternate CRON_SECRET bearer (Vercel Cron path)", async () => {
    process.env.CRON_SECRET = "cron-secret"
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("200s and warns when skipped_count > 0 (some collections not yet scanned)", async () => {
    rpcState.result = {
      data: {
        ran_at: "2026-07-12T00:00:00.000Z",
        promoted_count: 1,
        skipped_count: 3,
        promoted_emails: ["c@example.com"],
        skipped_detail: [{ email: "d@example.com", missing: ["allday"] }],
      },
      error: null,
    }
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped_count).toBe(3)
    expect(body.promoted_count).toBe(1)
  })
})

describe("POST /api/cron/allow-list-reconcile — failure paths", () => {
  it("500s (ok:false, ran_at present) when the reconcile RPC returns an error", async () => {
    rpcState.result = { data: null, error: { message: "reconcile failed" } }
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("reconcile failed")
    expect(typeof body.ran_at).toBe("string")
  })

  it("500s via the fatal catch when the reconcile RPC throws", async () => {
    rpcState.throwErr = true
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("rpc exploded")
    expect(typeof body.ran_at).toBe("string")
  })
})
