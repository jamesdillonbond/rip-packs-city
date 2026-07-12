import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/classify-acquisitions-multicollection.
// Data seam: supabaseAdmin from @/lib/supabase. Auth compares the Bearer token
// to a MODULE-captured `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""`, so we
// exercise BOTH regimes by resetting modules between them:
//   A. secret DELETED → TOKEN === "" → every request 401s (fail-closed `!TOKEN`).
//   B. secret SET      → wrong/no token 401s, correct token reaches the 202
//      { ok, accepted, pipeline } accept. The 3-collection classify loop is
//      after()-deferred; after() is stubbed no-op so the accept is observable
//      without any DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, so the stub is built inside it (TDZ otherwise).
vi.mock("@/lib/supabase", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  sb.rpc = async () => ({ data: { scanned: 10, classified: 8, skipped: 2 }, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { supabaseAdmin: sb, supabase: sb }
})

const url = "https://t/api/cron/classify-acquisitions-multicollection"

describe("POST /api/cron/classify-acquisitions-multicollection — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/cron/classify-acquisitions-multicollection/route")
    POST = mod.POST as any
  })

  it("401s fail-closed with no secret configured and no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s fail-closed even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })
})

describe("POST /api/cron/classify-acquisitions-multicollection — secret configured (success path)", () => {
  const TOKEN = "classify-ingest-token"
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/classify-acquisitions-multicollection/route")
    POST = mod.POST as any
  })

  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })

  it("202s and reports accepted with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("classify-acquisitions-multicollection")
  })
})
