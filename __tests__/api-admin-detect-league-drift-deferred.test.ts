import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/admin/cron/detect-league-drift's DEFERRED after() body (the
// sibling test only pins auth). It runs detect_league_set_drift, and only when it
// INSERTED new candidates does it fetch the open alerts (sorted by moment_count)
// and fire a Telegram digest — then always logs. Legs pinned: rpc error/throw →
// ok:false (no alerts/telegram), the inserted>0 alert fetch + moment_count sort,
// the Telegram digest (non-2xx + throw tolerated), the inserted==0 short-circuit,
// and the log-throw swallow.

vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.TELEGRAM_BOT_TOKEN = "bot"
  process.env.TELEGRAM_CHAT_ID = "chat"
})

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const st = vi.hoisted(() => ({
  detect: { data: null as any, error: null as any } as any,
  alerts: { data: [] as any[], error: null as any } as any,
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, _params?: any) => {
  if (name === "detect_league_set_drift") {
    if (st.detect === "THROW") throw new Error("detect exploded")
    return st.detect
  }
  return { data: null, error: null } // log_pipeline_run
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
    from: () => {
      const b: any = {}
      for (const m of ["select", "eq", "gte"]) b[m] = () => b
      b.then = (resolve: any) => resolve(st.alerts)
      return b
    },
  },
}))

import { GET } from "@/app/api/admin/cron/detect-league-drift/route"

const req = (token = "tok") =>
  ({ headers: new Headers({ authorization: `Bearer ${token}` }), nextUrl: new URL("https://t/api/admin/cron/detect-league-drift") }) as any

let telegramOk: boolean | null = true
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, _init: any) => {
    if (telegramOk === null) throw new Error("tg down")
    return { ok: telegramOk, status: telegramOk ? 200 : 500, text: async () => "err" }
  }))
}

beforeEach(() => {
  st.detect = { data: { inserted: 0, skipped_existing_open: 0 }, error: null }
  st.alerts = { data: [], error: null }
  rpc.mockClear()
  telegramOk = true
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive(r = req()) {
  const res = await GET(r)
  expect(res.status).toBe(200)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}
const fetchCalls = () => (globalThis.fetch as any).mock.calls

describe("/api/admin/cron/detect-league-drift — deferred body", () => {
  it("401 without the token; after() never scheduled", async () => {
    const res = await GET(req("wrong"))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("inserted==0 → no alert fetch, no Telegram, logs ok:true", async () => {
    st.detect = { data: { inserted: 0, skipped_existing_open: 3, detected_at: "2026-01-01" }, error: null }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_rows_written).toBe(0)
    expect(p.p_rows_skipped).toBe(3)
    expect(p.p_rows_found).toBe(3)
    expect(fetchCalls().length).toBe(0)
  })

  it("inserted>0 → fetches open alerts sorted by moment_count, fires Telegram, logs ok:true", async () => {
    st.detect = { data: { inserted: 2, skipped_existing_open: 0, detected_at: "2026-01-01" }, error: null }
    st.alerts = {
      data: [
        { set_name: "Low", evidence: { moment_count: 1, distinct_players: 1 } },
        { set_name: "High", evidence: { moment_count: 50, distinct_players: 9 } },
      ],
      error: null,
    }
    await drive()

    expect(fetchCalls().length).toBe(1)
    const tgBody = JSON.parse(fetchCalls()[0][1].body)
    // sorted desc by moment_count → "High" appears before "Low" in the digest
    expect(tgBody.text.indexOf("High")).toBeLessThan(tgBody.text.indexOf("Low"))
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_rows_written).toBe(2)
  })

  it("Telegram non-2xx is tolerated (still logs ok:true)", async () => {
    telegramOk = false
    st.detect = { data: { inserted: 1, skipped_existing_open: 0, detected_at: "2026-01-01" }, error: null }
    st.alerts = { data: [{ set_name: "S", evidence: { moment_count: 5 } }], error: null }
    await drive()
    expect(logParams().p_ok).toBe(true)
  })

  it("Telegram throwing is tolerated", async () => {
    telegramOk = null // fetch throws
    st.detect = { data: { inserted: 1, skipped_existing_open: 0, detected_at: "2026-01-01" }, error: null }
    st.alerts = { data: [{ set_name: "S", evidence: {} }], error: null }
    await drive()
    expect(logParams().p_ok).toBe(true)
  })

  it("an alert-fetch error is tolerated; Telegram still fires with empty bullets", async () => {
    st.detect = { data: { inserted: 1, skipped_existing_open: 0, detected_at: "2026-01-01" }, error: null }
    st.alerts = { data: null, error: { message: "alerts read failed" } }
    await drive()
    expect(logParams().p_ok).toBe(true)
    expect(fetchCalls().length).toBe(1)
  })

  it("detect rpc { error } → ok:false, no alerts/telegram", async () => {
    st.detect = { data: null, error: { message: "drift rpc down" } }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("drift rpc down")
    expect(fetchCalls().length).toBe(0)
  })

  it("detect rpc throwing → ok:false", async () => {
    st.detect = "THROW"
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("detect exploded")
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "detect_league_set_drift") return { data: { inserted: 0, skipped_existing_open: 0 }, error: null }
      throw new Error("log write failed")
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
