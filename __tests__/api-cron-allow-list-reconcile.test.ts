import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/allow-list-reconcile (GET + POST).
// Data seam: createClient from @supabase/supabase-js at module top. Auth is
// read at REQUEST time — 500 ({ error: "Server misconfigured..." }) if
// INGEST_SECRET_TOKEN is unset, else 401 on a missing/wrong Bearer token
// before the reconcile RPC. The 200 success surfaces reconcile_allow_list_prewarm()'s
// result verbatim under { ok: true, ...result }; we drive it with a chainable
// stub returning a promoted_count fixture and assert that field.

// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, and the route calls createClient() at module load (TDZ otherwise).
vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({
    data: {
      ran_at: "2026-07-12T00:00:00.000Z",
      promoted_count: 2,
      skipped_count: 0,
      promoted_emails: ["a@example.com", "b@example.com"],
      skipped_detail: [],
    },
    error: null,
  })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { createClient: () => sb }
})

import { POST, GET } from "@/app/api/cron/allow-list-reconcile/route"

const url = "https://t/api/cron/allow-list-reconcile"
const savedIngest = process.env.INGEST_SECRET_TOKEN

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
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
})
