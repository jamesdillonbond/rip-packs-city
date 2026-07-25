import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/cron/pinnacle-listings-reconcile (the sibling only pins auth).
// The route is in its ASK_UNIFY_RETIRED state: it authenticates, then logs a no-op
// pipeline run in after() and returns 202. Legs pinned: the missing-token 500, the
// auth (bearer + ?token=), the retired 202 envelope, the deferred log_pipeline_run
// (retired:true extra), the log-throw swallow, and the GET alias.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})
const st = vi.hoisted(() => ({ logThrows: false, logCalls: [] as any[] }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (name: string, params: any) => { if (name === "log_pipeline_run") { if (st.logThrows) throw new Error("log down"); st.logCalls.push(params) } return { data: null, error: null } } },
}))

import { POST, GET } from "@/app/api/cron/pinnacle-listings-reconcile/route"

const req = (opts: { auth?: string; token?: string } = {}) =>
  ({ headers: new Headers(opts.auth ? { authorization: opts.auth } : {}), nextUrl: new URL(`https://t/api/cron/pinnacle-listings-reconcile${opts.token ? `?token=${opts.token}` : ""}`) }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  st.logThrows = false
  st.logCalls = []
})

describe("/api/cron/pinnacle-listings-reconcile", () => {
  it("500 when INGEST_SECRET_TOKEN is not set", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req({ auth: "Bearer tok" }))).status).toBe(500)
  })
  it("401 with a wrong token", async () => {
    expect((await POST(req({ auth: "Bearer nope" }))).status).toBe(401)
  })
  it("202 retired envelope with a valid bearer, and the deferred log runs", async () => {
    const res = await POST(req({ auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.retired).toBe(true)
    expect(body.pipeline).toBe("pinnacle-listings-reconcile")
    expect(typeof capturedAfter).toBe("function")
    await capturedAfter!()
    expect(st.logCalls[0].p_ok).toBe(true)
    expect(st.logCalls[0].p_extra.retired).toBe(true)
  })
  it("accepts the token via ?token=", async () => {
    expect((await POST(req({ token: "tok" }))).status).toBe(202)
  })
  it("a log_pipeline_run throw is swallowed", async () => {
    st.logThrows = true
    await POST(req({ auth: "Bearer tok" }))
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
  it("GET alias reaches the same 202", async () => {
    expect((await GET(req({ auth: "Bearer tok" }))).status).toBe(202)
  })
})
