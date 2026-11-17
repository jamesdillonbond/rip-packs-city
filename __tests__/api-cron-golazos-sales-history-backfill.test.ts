import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/golazos-sales-history-backfill (+ GET).
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import (CRON_SECRET is read
// at request time). We exercise BOTH regimes via vi.resetModules():
//   A. secret DELETED → TOKEN === "" → every request 401s (fail-closed).
//   B. secret SET      → wrong/no token 401s; the correct token reaches a real
//      200 accept.
//
// The main backfill is a SYNCHRONOUS Flow-REST block-scanner (no after()), so we
// don't drive the heavy on-chain fan-out. Instead we drive the route's genuine
// short-circuit 200 accept: with the event_cursor stubbed at the spork floor, the
// handler's `end < SPORK_FLOOR_HINT` guard returns { note: "reached_spork_floor" }
// BEFORE any global fetch / scanRange, exercising the auth gate + the saturation
// + cursor reads against a chainable @/lib/supabase stub. No brittle fetch mock.

const SPORK_FLOOR_HINT = 137_390_146
const sb = vi.hoisted(() => {
  const FLOOR = 137_390_146
  const s: any = {}
  for (const m of ["from", "select", "eq", "neq", "in", "gte", "lte", "order", "limit", "insert", "upsert", "delete"]) s[m] = () => s
  // event_cursor read → pin the ceiling to the spork floor so end < SPORK_FLOOR_HINT.
  s.maybeSingle = async () => ({ data: { last_processed_block: FLOOR }, error: null })
  s.single = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  // Saturation read (pipeline_runs count) resolves to 0 recent fails.
  s.then = (resolve: any) => resolve({ data: [], error: null, count: 0 })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({}) }))

const url = "https://t/api/cron/golazos-sales-history-backfill"

describe("POST /api/cron/golazos-sales-history-backfill — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    delete process.env.CRON_SECRET
    const mod = await import("@/app/api/cron/golazos-sales-history-backfill/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("401s fail-closed with no secret configured and no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s fail-closed even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })

  it("GET alias enforces the same guard", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/cron/golazos-sales-history-backfill — secret configured (success path)", () => {
  const TOKEN = "golazos-backfill-token"
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    delete process.env.CRON_SECRET
    delete process.env.GOLAZOS_SALES_HISTORY_BACKFILL_DISABLED
    const mod = await import("@/app/api/cron/golazos-sales-history-backfill/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("still 401s with no token", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200s and reports 'reached_spork_floor' with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("reached_spork_floor")
    expect(body.floor).toBe(SPORK_FLOOR_HINT)
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: TOKEN }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("reached_spork_floor")
  })

  it("GET alias reaches the same accept when authed", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
    const res = await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    expect((await res.json()).floor).toBe(SPORK_FLOOR_HINT)
  })
})
