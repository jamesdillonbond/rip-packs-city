import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/admin/analytics-smoke's DEFERRED after() body (the sibling
// test only pins auth + the 202 ack). runSmoke() wraps analytics_smoke_run() and
// must classify every outcome into log_pipeline_run so the CRON-30S after() move
// never goes dark: a SATURATION rpc error is an inconclusive PASS (warn), a
// non-saturation rpc error is a hard fail, a null envelope is a fail, a
// severity=fail envelope fires Telegram + logs ok:false, an ok/warn envelope logs
// ok:true, and a thrown runSmoke is caught by the fatal guard. All pinned here.

vi.hoisted(() => {
  process.env.TELEGRAM_BOT_TOKEN = "bot"
  process.env.TELEGRAM_CHAT_ID = "chat"
})

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const st = vi.hoisted(() => ({
  authed: true,
  saturated: false,
  smoke: { data: null as any, error: null as any },
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, _params?: any) => {
  if (name === "analytics_smoke_run") {
    if (st.smoke.error === "THROW") throw new Error("rpc exploded")
    return st.smoke
  }
  return { data: null, error: null } // log_pipeline_run
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...a: any[]) => rpc(...(a as [string, any?])) } }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@/lib/pipeline/saturation", () => ({ isSaturationError: () => st.saturated }))

import { GET } from "@/app/api/admin/analytics-smoke/route"

const req = () => ({ headers: new Headers(), nextUrl: new URL("https://t/api/admin/analytics-smoke"), url: "https://t/api/admin/analytics-smoke" }) as any

let telegramOk = true
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (telegramOk === null) throw new Error("telegram down")
    return { ok: telegramOk }
  }))
}

const envelope = (over: any = {}) => ({
  ran_at: "2026-07-25T00:00:00Z", total_ms: 12, check_count: 5, fail_count: 0, warn_count: 0,
  overall_severity: "ok", results: [], ...over,
})

beforeEach(() => {
  st.authed = true
  st.saturated = false
  st.smoke = { data: envelope(), error: null }
  rpc.mockClear()
  telegramOk = true
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive() {
  const res = await GET(req())
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

describe("/api/admin/analytics-smoke — deferred body", () => {
  it("401 when not an admin; after() never scheduled", async () => {
    st.authed = false
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("ok envelope → logs ok:true, no Telegram", async () => {
    st.smoke = { data: envelope({ overall_severity: "ok", check_count: 5 }), error: null }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(5)
    expect(p.p_extra.telegram_sent).toBe(false)
    expect((globalThis.fetch as any).mock.calls.length).toBe(0)
  })

  it("severity=fail → fires Telegram and logs ok:false with the fail summary", async () => {
    st.smoke = {
      data: envelope({ overall_severity: "fail", fail_count: 2, check_count: 5, results: [
        { name: "chk1", severity: "fail", ms: 3, detail: { x: 1 } },
        { name: "chk2", severity: "fail", ms: 4, detail: "boom" },
      ] }),
      error: null,
    }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("2 fail")
    expect(p.p_extra.telegram_sent).toBe(true)
    expect((globalThis.fetch as any).mock.calls.length).toBe(1)
  })

  it("severity=fail but Telegram throwing → telegram_sent false, still logs the fail", async () => {
    telegramOk = null // fetch throws
    st.smoke = { data: envelope({ overall_severity: "fail", fail_count: 1, results: [{ name: "c", severity: "fail", ms: 1, detail: {} }] }), error: null }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_extra.telegram_sent).toBe(false)
  })

  it("saturation rpc error → inconclusive PASS (ok:true, warn=db_saturated)", async () => {
    st.saturated = true
    st.smoke = { data: null, error: { message: "canceling statement due to statement timeout" } }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true) // saturated ⇒ inconclusive pass, not a hard fail
    expect(p.p_error).toContain("inconclusive (db saturated)")
    expect(p.p_extra.inconclusive).toBe(true)
    expect(p.p_extra.warn).toBe("db_saturated")
  })

  it("non-saturation rpc error → hard fail", async () => {
    st.saturated = false
    st.smoke = { data: null, error: { message: "relation does not exist" } }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("analytics_smoke_run: relation does not exist")
  })

  it("null envelope → logs a hard fail", async () => {
    st.smoke = { data: null, error: null }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("returned null")
  })

  it("a thrown runSmoke is caught by the fatal guard and logged", async () => {
    st.smoke = { data: null, error: "THROW" }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("smoke crashed")
    expect(p.p_extra.fatal).toBe(true)
  })
})
