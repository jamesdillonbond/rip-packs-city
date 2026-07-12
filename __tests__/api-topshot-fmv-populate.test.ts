import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/topshot-fmv-populate (GET + POST, same
// `handle`). Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a
// module-level `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import — so
// we exercise BOTH regimes by resetting modules between them:
//   A. secret DELETED → TOKEN === "" → every request 401s (fail-closed).
//   B. secret SET      → wrong/no token 401s, correct bearer/?token reaches the
//      202 { accepted:true, pipeline } accept. The cursor-paginated GQL sweep
//      runs inside after() (stubbed no-op) so the ack is observable without any
//      proxy/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const url = "https://t/api/topshot-fmv-populate"
const savedIngest = process.env.INGEST_SECRET_TOKEN
afterAll(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("/api/topshot-fmv-populate — no secret configured (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/topshot-fmv-populate/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("GET 401s without a token", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
  it("POST 401s without a token", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })
  it("401s even with a ?token= when no secret is configured", async () => {
    expect((await GET(makeReq({ url, method: "GET", token: "x" }))).status).toBe(401)
  })
})

describe("/api/topshot-fmv-populate — secret configured (success path)", () => {
  const TOKEN = "topshot-fmv-token"
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/topshot-fmv-populate/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("202-accepts with the correct bearer token (sweep deferred)", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("topshot-fmv-populate")
  })

  it("202-accepts with the correct ?token= query param", async () => {
    expect((await POST(makeReq({ url, token: TOKEN }))).status).toBe(202)
  })

  it("GET reaches the same 202 accept when authed", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))).status).toBe(202)
  })
})
