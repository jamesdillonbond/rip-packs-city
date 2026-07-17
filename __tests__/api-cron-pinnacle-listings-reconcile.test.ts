import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/pinnacle-listings-reconcile (+ GET).
// Two-stage fail-closed guard (read at REQUEST time): 500 if INGEST_SECRET_TOKEN
// is unset, else 401 on a missing/wrong Bearer or ?token= before any reconcile.
// Beyond the guard we drive the CRON-30S accept: the reconcile RPC +
// log_pipeline_run run inside after() (stubbed no-op), so the immediate 202
// {ok:true,accepted:true,pipeline:"pinnacle-listings-reconcile"} ack is
// observable without the RPC ever firing.

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

import { POST, GET } from "@/app/api/cron/pinnacle-listings-reconcile/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-listings-reconcile"),
  }) as any

const url = "https://t/api/cron/pinnacle-listings-reconcile"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("POST /api/cron/pinnacle-listings-reconcile", () => {
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

describe("POST /api/cron/pinnacle-listings-reconcile — success path (202 accept, reconcile deferred)", () => {
  it("202s and reports accepted:true + the pipeline name with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    // ASK-unify retirement (524a01c9, 2026-07-17): the route is a logged no-op
    // behind ASK_UNIFY_RETIRED and its ack is { accepted, retired, pipeline }
    // (no `ok` field) until the cron entry is deleted.
    expect(body.accepted).toBe(true)
    expect(body.retired).toBe(true)
    expect(body.pipeline).toBe("pinnacle-listings-reconcile")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("pinnacle-listings-reconcile")
  })
})
