import { describe, it, expect, beforeAll, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/cron/detect-league-drift. Gated on
// Bearer INGEST_SECRET_TOKEN / ?token= (TOKEN captured at module load). Two
// regimes via resetModules:
//   A. no secret  → TOKEN==="" → fail-closed 401 {ok:false}.
//   B. secret set → the correct bearer reaches the immediate 200 {ok:true} ack;
//      detect_league_set_drift + Telegram + logging are after()-deferred
//      (stubbed no-op), so the ack is observable without DB/Telegram I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

describe("GET /api/admin/cron/detect-league-drift — no secret (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/admin/cron/detect-league-drift/route")
    GET = mod.GET as any
  })

  it("401s without a valid token (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/cron/detect-league-drift"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer", async () => {
    const res = await GET(adminReq("https://t/api/admin/cron/detect-league-drift", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/admin/cron/detect-league-drift — secret set (success path)", () => {
  const TOKEN = "league-drift-ingest"
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/admin/cron/detect-league-drift/route")
    GET = mod.GET as any
  })

  it("200s {ok:true} with the correct bearer (detection deferred to after())", async () => {
    const res = await GET(adminReq("https://t/api/admin/cron/detect-league-drift", { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
