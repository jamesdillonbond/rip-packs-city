import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/cron/weekly-digest (P3 retention email).
// The route is DISABLED by default (WEEKLY_DIGEST_ENABLED) and idempotent via
// alert_deliveries. We drive: auth fail-closed, the ?dry=1 preview (no send),
// the disabled real-run skip, and the enabled send loop (after() captured and
// invoked, fetch/Resend stubbed).

const h = vi.hoisted(() => ({
  state: {
    movers: [] as any[],
    emailSub: null as any, // maybeSingle result for email_subscribers
    alertDup: null as any, // maybeSingle result for alert_deliveries (alreadySent)
    rpcCalls: [] as any[],
    afterFns: [] as Array<() => any>,
  },
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => any) => { h.state.afterFns.push(fn) } }
})

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    const result =
      table === "email_subscribers"
        ? { data: h.state.emailSub, error: null }
        : table === "alert_deliveries"
          ? { data: h.state.alertDup, error: null }
          : { data: null, error: null }
    const b: any = {}
    for (const m of ["select", "insert", "update", "upsert", "eq", "neq", "order", "limit", "not"]) b[m] = () => b
    b.maybeSingle = async () => result
    b.single = async () => result
    b.then = (resolve: any) => resolve(result) // awaiting the chain (insert/update) resolves here
    return b
  }
  const supabaseAdmin: any = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => {
      h.state.rpcCalls.push({ name, args })
      if (name === "get_weekly_portfolio_movers") return { data: h.state.movers, error: null }
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin }
})

const TOKEN = "weekly-digest-ingest"
const MOVER = {
  user_id: "u1", email: "A@B.com", latest_fmv: 100, prior_fmv: 90,
  delta_usd: 10, delta_pct: 11.11, moment_count: 5, latest_date: "2026-07-20",
}

async function load() {
  const mod = await import("@/app/api/cron/weekly-digest/route")
  return mod.GET as (req: any) => Promise<Response>
}

beforeEach(() => {
  h.state.movers = []
  h.state.emailSub = null
  h.state.alertDup = null
  h.state.rpcCalls = []
  h.state.afterFns = []
  process.env.INGEST_SECRET_TOKEN = TOKEN
  delete process.env.WEEKLY_DIGEST_ENABLED
})
afterEach(() => vi.unstubAllGlobals())

describe("weekly-digest — auth", () => {
  it("401s without a token", async () => {
    const GET = await load()
    const res = await GET(adminReq("https://t/api/cron/weekly-digest"))
    expect(res.status).toBe(401)
  })
})

describe("weekly-digest — dry run (previews, sends nothing)", () => {
  it("returns the recipient list", async () => {
    h.state.movers = [MOVER]
    const GET = await load()
    const res = await GET(adminReq("https://t/api/cron/weekly-digest?dry=1", { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dry).toBe(true)
    expect(body.would_send).toBe(1)
    expect(body.recipients[0].email).toBe("a@b.com") // lowercased
    // dry run must not call log_pipeline_run and must not send
    expect(h.state.rpcCalls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)
  })

  it("skips unsubscribed recipients", async () => {
    h.state.movers = [MOVER]
    h.state.emailSub = { unsubscribed_at: "2026-07-01T00:00:00Z" }
    const GET = await load()
    const res = await GET(adminReq("https://t/api/cron/weekly-digest?dry=1", { authorization: `Bearer ${TOKEN}` }))
    const body = await res.json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_unsubscribed).toBe(1)
  })
})

describe("weekly-digest — disabled real run", () => {
  it("202 skipped:disabled and logs it", async () => {
    h.state.movers = [MOVER]
    const GET = await load()
    const res = await GET(adminReq("https://t/api/cron/weekly-digest", { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("disabled")
    const log = h.state.rpcCalls.find((c) => c.name === "log_pipeline_run")
    expect(log?.args?.p_extra?.skipped).toBe("disabled")
    expect(h.state.afterFns).toHaveLength(0) // never enters the send loop
  })
})

describe("weekly-digest — enabled real run", () => {
  it("sends and records one delivery", async () => {
    process.env.WEEKLY_DIGEST_ENABLED = "1"
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as any)
    vi.stubGlobal("fetch", fetchMock)
    h.state.movers = [MOVER]

    const GET = await load()
    const res = await GET(adminReq("https://t/api/cron/weekly-digest", { authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)

    // Run the captured after() body.
    expect(h.state.afterFns).toHaveLength(1)
    await h.state.afterFns[0]()

    expect(fetchMock).toHaveBeenCalledTimes(1) // one Resend send
    const log = h.state.rpcCalls.find((c) => c.name === "log_pipeline_run")
    expect(log?.args?.p_rows_written).toBe(1)
    expect(log?.args?.p_ok).toBe(true)
  })
})
