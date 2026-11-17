import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/wmc-fmv-populate (GET + POST, same `handle`).
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import. We exercise BOTH
// regimes with vi.resetModules() between them:
//   A. secret DELETED → TOKEN === "" → fail-closed 401 (authorize returns false
//      before !TOKEN even reaches the token compare).
//   B. secret SET      → wrong/no token 401s, correct bearer/?token reaches the
//      202 { accepted:true, targets, force, limit, refresh } accept. The
//      per-collection FMV+image RPCs run inside after() (stubbed no-op), so the
//      ack is observable without any Supabase I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const url = "https://t/api/wmc-fmv-populate"
const savedIngest = process.env.INGEST_SECRET_TOKEN
afterAll(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("/api/wmc-fmv-populate — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/wmc-fmv-populate/route")
    POST = mod.POST as any
  })

  it("401s without authorization", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("401s even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })
})

describe("/api/wmc-fmv-populate — secret configured (success path)", () => {
  const TOKEN = "wmc-fmv-token"
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/wmc-fmv-populate/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("202-accepts with the correct bearer token (all-collection tick)", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(Array.isArray(body.targets)).toBe(true)
    expect(body.targets.length).toBeGreaterThan(0)
    // No ?collection= and no ?skip_refresh → the drift refresh is scheduled.
    expect(body.refresh).toBe(true)
    expect(body.force).toBe(false)
  })

  it("202-accepts with the correct ?token= query param", async () => {
    expect((await POST(makeReq({ url, token: TOKEN }))).status).toBe(202)
  })

  it("GET reaches the same 202 accept when authed", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))).status).toBe(202)
  })
})
