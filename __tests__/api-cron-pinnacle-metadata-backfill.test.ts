import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/pinnacle-metadata-backfill.
// Fail-closed auth: the GET handler checks a Bearer token / ?token= against a
// MODULE-CAPTURED `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` and 401s on a
// missing/wrong credential (also when unset, via `!TOKEN`). The data seam is
// `createClient` from @supabase/supabase-js (called at module top), stubbed to a
// self-referential chainable that resolves every queue read to []. With all four
// queues empty the route never fans out any Cadence/Flow REST call and runs
// straight to the 200 body — so the success path is driven with no live I/O.
// The module-load token means the success case uses a two-regime dynamic import.

const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { GET } from "@/app/api/cron/pinnacle-metadata-backfill/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-metadata-backfill"),
  }) as any

const url = "https://t/api/cron/pinnacle-metadata-backfill"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("GET /api/cron/pinnacle-metadata-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/pinnacle-metadata-backfill — success path (empty queues, no fan-out)", () => {
  const TOKEN = "pinnacle-metadata-token"
  let GET2: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/pinnacle-metadata-backfill/route")
    GET2 = mod.GET as any
  })

  it("200s with ok:true and zero corrections when every queue is empty (Bearer)", async () => {
    const res = await GET2(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.gql_errors).toBe(0)
    expect(body.mint_count_filled).toBe(0)
    expect(body.catalog_upserted).toBe(0)
    expect(typeof body.duration_ms).toBe("number")
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await GET2(makeReq({ url, method: "GET", token: TOKEN }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("still 401s with a wrong bearer token under the configured secret", async () => {
    expect((await GET2(makeReq({ url, method: "GET", auth: "Bearer wrong" }))).status).toBe(401)
  })
})
