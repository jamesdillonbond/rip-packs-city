import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/allday-badge-ingest.
// Fail-closed auth: the POST handler accepts Bearer INGEST_SECRET_TOKEN or
// CRON_SECRET only, returning 401 otherwise before any badge ingest. We pin the
// guard AND drive the real 200: the token is read at REQUEST time, the DB seam is
// supabaseAdmin from @/lib/supabase (chainable stub — upsert/rpc return no error),
// and the handler is synchronous, so { ok, upserted, upsertErrors, jerseyUpdated }
// reflects the mocked upsert of the posted rows.

const sb: any = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: 0, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  // upsert() is awaited directly for its { error } — resolve to no-error.
  s.upsert = () => ({ then: (resolve: any) => resolve({ error: null }) })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/allday-badge-ingest"),
  }) as any

import { POST } from "@/app/api/cron/allday-badge-ingest/route"

const url = "https://t/api/cron/allday-badge-ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-badge-ingest", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/allday-badge-ingest — success path (synchronous upsert)", () => {
  it("200s with ok:true and upserted:0 for an empty rows payload", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: { rows: [] } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(0)
    expect(body.upsertErrors).toBe(0)
  })

  it("200s and reports upserted:1 for one valid badge row (mocked upsert, no error)", async () => {
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-cron-secret",
        body: {
          rows: [
            {
              external_id: 12345,
              player_name: "Test Player",
              set_name: "Test Set",
              tier: "COMMON",
              badges: [{ slug: "all-day-debut", title: "All Day Debut" }],
              circulation_count: 100,
            },
          ],
        },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(1)
    expect(body.upsertErrors).toBe(0)
  })

  it("400s on malformed JSON body (after auth passes)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad json")
  })
})
