import { describe, it, expect, beforeAll, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-allday-buyers (GET + POST share
// one handler). Auth accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET / ?token=;
// the tokens are captured at module load, so we exercise BOTH regimes via
// resetModules:
//   A. no secret  → TOKEN==="" → every request fail-closed 401.
//   B. secret set → the correct bearer reaches the 200 "queued" accept; the
//      heavy per-tx Cadence/Flow decode is after()-deferred (stubbed no-op) and
//      the buyer decoder is mocked inert, so the ack is observable without I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({}) }))

describe("/api/admin/backfill-allday-buyers — no secret (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    delete process.env.CRON_SECRET
    const mod = await import("@/app/api/admin/backfill-allday-buyers/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("GET 401s without a valid token (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-allday-buyers"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s without a valid token (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-allday-buyers", { authorization: "Bearer wrong" }))
    expect(res.status).toBe(401)
  })
})

describe("/api/admin/backfill-allday-buyers — secret set (success path)", () => {
  const TOKEN = "allday-buyers-ingest"
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/admin/backfill-allday-buyers/route")
    POST = mod.POST as any
  })

  it("still 401s with a wrong bearer", async () => {
    expect((await POST(adminReq("https://t/api/admin/backfill-allday-buyers", { authorization: "Bearer nope" }))).status).toBe(401)
  })

  it("200s and reports the backfill queued with the correct bearer", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-allday-buyers", { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(true)
    expect(body.collection).toBe("allday")
  })
})
