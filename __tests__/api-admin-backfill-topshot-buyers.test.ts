import { describe, it, expect, beforeAll, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/backfill-topshot-buyers. Gated on
// Bearer INGEST_SECRET_TOKEN / ?token= (TOKEN captured at module load). Two
// regimes via resetModules:
//   A. no secret  → TOKEN==="" → fail-closed 401.
//   B. secret set → the ?mode=historical lane is inert-by-default (the spork
//      backfill env flag is unset), so it returns a synchronous 200
//      {queued:false, skipped:"historical_disabled"} — a real authed 2xx that
//      needs no Cadence/Flow I/O.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

describe("POST /api/admin/backfill-topshot-buyers — no secret (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/admin/backfill-topshot-buyers/route")
    POST = mod.POST as any
  })

  it("401s without a valid token (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-buyers"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/admin/backfill-topshot-buyers — secret set (success path)", () => {
  const TOKEN = "topshot-buyers-ingest"
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    delete process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED
    const mod = await import("@/app/api/admin/backfill-topshot-buyers/route")
    POST = mod.POST as any
  })

  it("200s the historical lane as inert-by-default with the correct bearer", async () => {
    const res = await POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers?mode=historical", { authorization: `Bearer ${TOKEN}` })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(false)
    expect(body.skipped).toBe("historical_disabled")
  })
})
