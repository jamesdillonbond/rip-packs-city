import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/admin/apply-fmv-haircut (the sibling only pins auth).
// mode=dry is synchronous (returns the preview counts); mode=live is 202 +
// after() (the daily cron). Legs pinned: auth, mode validation, unknown-collection
// 400, the dry-run success + rpc-error 500, and the deferred live body — rpc
// returned-error vs THROW both logging ok:false (the 2026-06-11 dark-run guard),
// the success log with the examined/haircut/skipped split, and the log-throw swallow.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})
const st = vi.hoisted(() => ({ authed: true, haircut: { data: null as any, error: null as any }, haircutThrows: false, logThrows: false }))
const rpc = vi.hoisted(() => vi.fn(async (name: string, _p?: any) => {
  if (name === "fmv_apply_thin_sale_haircut") { if (st.haircutThrows) throw new Error("pool timeout"); return st.haircut }
  if (name === "log_pipeline_run") { if (st.logThrows) throw new Error("log down"); return { data: null, error: null } }
  return { data: null, error: null }
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...a: any[]) => rpc(...(a as [string, any?])) } }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))

import { POST } from "@/app/api/admin/apply-fmv-haircut/route"

const post = (qs = "?mode=dry") => ({ nextUrl: new URL(`https://t/api/admin/apply-fmv-haircut${qs}`) }) as any

beforeEach(() => {
  st.authed = true
  st.haircut = { data: [{ rows_examined: 100, rows_haircut: 12, total_dollars_removed: 340.5 }], error: null }
  st.haircutThrows = false
  st.logThrows = false
  capturedAfter = null
  rpc.mockClear()
})
function logParams() { return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1] }

describe("POST /api/admin/apply-fmv-haircut", () => {
  it("401 when not an admin", async () => {
    st.authed = false
    expect((await POST(post())).status).toBe(401)
  })
  it("400 for an invalid mode", async () => {
    expect((await POST(post("?mode=bogus"))).status).toBe(400)
  })
  it("400 for an unknown collection", async () => {
    const res = await POST(post("?mode=dry&collection=nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })
  it("mode=dry returns the preview counts synchronously", async () => {
    const body = await (await POST(post("?mode=dry&collection=topshot"))).json()
    expect(body.mode).toBe("dry")
    expect(body.rows_examined).toBe(100)
    expect(body.rows_haircut).toBe(12)
    expect(body.total_dollars_removed).toBe(340.5)
  })
  it("mode=dry rpc error → 500", async () => {
    st.haircut = { data: null, error: { message: "rpc down" } }
    expect((await POST(post("?mode=dry"))).status).toBe(500)
  })

  it("mode=live: 202 accepted, then the deferred body logs ok:true with the split", async () => {
    const res = await POST(post("?mode=live"))
    expect(res.status).toBe(202)
    expect(typeof capturedAfter).toBe("function")
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_rows_found).toBe(100)
    expect(p.p_rows_written).toBe(12)
    expect(p.p_rows_skipped).toBe(88) // examined - haircut
    expect(p.p_extra.total_dollars_removed).toBe(340.5)
  })
  it("mode=live: a returned rpc error logs ok:false", async () => {
    st.haircut = { data: null, error: { message: "rpc error" } }
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("rpc error")
  })
  it("mode=live: a THROWN rpc still logs ok:false (the dark-run guard)", async () => {
    st.haircutThrows = true
    await POST(post("?mode=live"))
    await capturedAfter!()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("pool timeout")
  })
  it("mode=live: a log_pipeline_run throw is swallowed", async () => {
    st.logThrows = true
    await POST(post("?mode=live"))
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
