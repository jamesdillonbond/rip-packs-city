import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/ufc-sales-history-backfill.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET or ?token= (fail-closed length gate)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the route is SYNCHRONOUS and awaits a backward Flow REST event
// scan before responding — but that scan is cleanly stubbable. With the three
// event-fetch calls returning EMPTY block arrays (global fetch stub) and the
// scan window narrowed to one chunk (?range=250), zero sales are found, nothing
// is inserted, and the route returns its real terminal 200
// { ok:true, found:0, sales_written:0, ... }. The Supabase stub covers the
// saturation head-count (count:0), the cursor read (maybeSingle→null so the
// ceiling stays at the init block, above the spork floor), the cursor upsert,
// and the log/promote RPCs — so the whole synchronous pipeline runs to its
// success return with no real network or DB I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  neq: () => sbChain,
  in: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  gte: () => sbChain,
  is: () => sbChain,
  not: () => sbChain,
  update: () => sbChain,
  upsert: () => sbChain,
  insert: () => sbChain,
  maybeSingle: async () => ({ data: null, error: null }),
  then: (r: any) => r({ data: [], error: null, count: 0 }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({}) }))

// Every Flow REST event-range fetch returns an empty block list → zero sales.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => "[]",
  })),
)

import { makeReq } from "./cron-req-helper"

// One-chunk scan window so the backward walk is a single (stubbed) fetch batch.
const url = "https://t/api/cron/ufc-sales-history-backfill?range=250"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/ufc-sales-history-backfill/route")
})

describe("POST /api/cron/ufc-sales-history-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/ufc-sales-history-backfill — success path (empty scan)", () => {
  it("200s with ok:true and found:0 when the backward scan finds no sales (authed)", async () => {
    const res = await mod.POST(makeReq({ url, method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pipeline).toBe("ufc-sales-history-backfill")
    expect(body.found).toBe(0)
    expect(body.sales_written).toBe(0)
    expect(body.below_floor).toBe(false)
  })
})
