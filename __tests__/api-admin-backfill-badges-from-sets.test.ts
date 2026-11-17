import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/backfill-badges-from-sets. Gated on
// Bearer INGEST_SECRET_TOKEN (read at request time). Fail-closed 401 plus a 2xx
// success path: with the editions / badge_editions / sets reads mocked empty,
// the sweep resolves 0 missing rows and never fans out to the Top Shot GQL, so
// ?dryRun=1 returns a synchronous {ok:true, dryRun:true, totalMissing:0} summary.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    order: () => sb,
    eq: () => sb,
    not: () => sb,
    in: () => sb,
    insert: async () => ({ data: null, error: null }),
    upsert: async () => ({ data: null, error: null }),
    range: async () => ({ data: [], error: null }),
  }
  return { supabaseAdmin: sb }
})
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { POST } from "@/app/api/admin/backfill-badges-from-sets/route"

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/admin/backfill-badges-from-sets", () => {
  it("401s when INGEST_SECRET_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-badges-from-sets"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer nope" })
    )
    expect(res.status).toBe(401)
  })

  it("200s a dryRun summary with 0 missing rows when the catalog is fully backfilled (authed)", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets?dryRun=1", { authorization: "Bearer ingest" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.dryRun).toBe(true)
    expect(body.totalMissing).toBe(0)
  })
})
