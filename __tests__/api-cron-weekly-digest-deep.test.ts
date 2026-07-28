import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Deep-drive of /api/cron/weekly-digest's UNCOVERED silent-failure legs — the
// after() send-loop branches the happy-path sibling test never reaches. These
// are the retention-email's correctness contracts, and the after() body is the
// exact silent-run shape the 06-10/06-11 dark-run incidents came from (route
// answers 202, cron entry stays enabled, the work fails invisibly). Pinned:
//   - a transient send failure is RETRY-SAFE: skipped, NO alert_deliveries row
//     written (so a later run this week retries), pipeline stays ok=true, and
//     the error string still surfaces in the log;
//   - loadMovers throwing inside after() → ok=false with a "threw:" error;
//   - a missing RESEND_API_KEY degrades to a per-send failure, not a hard crash;
//   - already-sent (dedup) + within-run duplicate email both skip without sending;
//   - an ensured-opt-out (digest_weekly=false) skips;
//   - a new subscriber gets a token inserted then sent;
//   - an alert_deliveries insert unique-violation is tolerated (email went out);
//   - the dry-run already-sent + error(500) legs.

const h = vi.hoisted(() => ({
  cfg: {
    movers: [] as any[],
    moversError: null as string | null,
    emailSubQueue: [] as any[], // maybeSingle results for email_subscribers, in order
    alertSentQueue: [] as any[], // maybeSingle results for alert_deliveries (alreadySent), in order
    emailInsertErr: null as any,
    alertInsertErr: null as any,
  },
  rpcCalls: [] as any[],
  afterFns: [] as Array<() => any>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => any) => { h.afterFns.push(fn) } }
})

const shift = (q: any[]) => (q && q.length ? q.shift() : null)

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    let op = "select"
    const b: any = {}
    for (const m of ["select", "eq", "neq", "order", "limit", "not"]) b[m] = () => b
    b.insert = () => { op = "insert"; return b }
    b.update = () => { op = "update"; return b }
    b.upsert = () => { op = "upsert"; return b }
    const sel = async () => {
      if (table === "email_subscribers") return { data: shift(h.cfg.emailSubQueue), error: null }
      if (table === "alert_deliveries") return { data: shift(h.cfg.alertSentQueue), error: null }
      return { data: null, error: null }
    }
    b.maybeSingle = sel
    b.single = sel
    b.then = (resolve: any) => {
      let error = null
      if (op === "insert" && table === "email_subscribers") error = h.cfg.emailInsertErr ?? null
      if (op === "insert" && table === "alert_deliveries") error = h.cfg.alertInsertErr ?? null
      return resolve({ data: null, error })
    }
    return b
  }
  const supabaseAdmin: any = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => {
      h.rpcCalls.push({ name, args })
      if (name === "get_weekly_portfolio_movers") {
        if (h.cfg.moversError) return { data: null, error: { message: h.cfg.moversError } }
        return { data: h.cfg.movers, error: null }
      }
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin }
})

const TOKEN = "weekly-digest-ingest"
const mover = (over: Partial<Record<string, any>> = {}) => ({
  user_id: "u1", email: "A@B.com", latest_fmv: 100, prior_fmv: 90,
  delta_usd: 10, delta_pct: 11.11, moment_count: 5, latest_date: "2026-07-20", ...over,
})
const withToken = { verification_token: "tok", unsubscribed_at: null, digest_weekly: true }

async function load() {
  const mod = await import("@/app/api/cron/weekly-digest/route")
  return mod.GET as (req: any) => Promise<Response>
}
const call = (GET: any, qs = "") =>
  GET(adminReq(`https://t/api/cron/weekly-digest${qs}`, { authorization: `Bearer ${TOKEN}` }))
const digestLog = () => h.rpcCalls.find((c) => c.name === "log_pipeline_run")?.args

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  h.cfg = { movers: [], moversError: null, emailSubQueue: [], alertSentQueue: [], emailInsertErr: null, alertInsertErr: null }
  h.rpcCalls = []
  h.afterFns = []
  process.env.INGEST_SECRET_TOKEN = TOKEN
  process.env.WEEKLY_DIGEST_ENABLED = "1"
  process.env.RESEND_API_KEY = "re_test"
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as any)
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.WEEKLY_DIGEST_ENABLED
})

describe("weekly-digest — after() send failure is retry-safe", () => {
  it("a Resend non-ok response skips the recipient, writes NO delivery row, keeps ok=true, surfaces the error", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null] // not already sent
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "resend down" } as any)

    const res = await call(await load())
    expect(res.status).toBe(202)
    await h.afterFns[0]()

    const log = digestLog()
    expect(log.p_rows_written).toBe(0) // nothing sent
    expect(log.p_rows_skipped).toBe(1)
    expect(log.p_ok).toBe(true) // NOT a hard failure — a later run retries
    expect(String(log.p_error)).toContain("send")
    expect(String(log.p_error)).toContain("500")
  })

  it("a missing RESEND_API_KEY degrades to a per-send failure, not a crash", async () => {
    delete process.env.RESEND_API_KEY
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]

    await call(await load())
    await h.afterFns[0]()

    const log = digestLog()
    expect(log.p_ok).toBe(true)
    expect(log.p_rows_skipped).toBe(1)
    expect(String(log.p_error)).toContain("RESEND_API_KEY missing")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("weekly-digest — after() control flow", () => {
  it("loadMovers throwing inside after() logs ok=false with a threw: error", async () => {
    h.cfg.moversError = "movers boom"
    await call(await load())
    await h.afterFns[0]()
    const log = digestLog()
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("threw:")
    expect(String(log.p_error)).toContain("get_weekly_portfolio_movers")
  })

  it("skips an already-sent recipient (weekly dedup) without sending", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [{ id: "d1" }] // alreadySent → true
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
    const log = digestLog()
    expect(log.p_rows_written).toBe(0)
    expect(log.p_rows_skipped).toBe(1)
    expect(log.p_ok).toBe(true)
  })

  it("skips a within-run duplicate email (sends once)", async () => {
    h.cfg.movers = [mover({ user_id: "u1" }), mover({ user_id: "u2" })] // same email A@B.com
    h.cfg.emailSubQueue = [withToken] // only the first reaches ensureUnsubToken
    h.cfg.alertSentQueue = [null]
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const log = digestLog()
    expect(log.p_rows_written).toBe(1)
    expect(log.p_rows_skipped).toBe(1)
  })

  it("skips a recipient who turned the weekly digest off (digest_weekly=false)", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [{ verification_token: "t", unsubscribed_at: null, digest_weekly: false }]
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(digestLog().p_rows_skipped).toBe(1)
  })

  it("inserts a token for a brand-new subscriber then sends", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [null] // no existing row → insert path
    h.cfg.emailInsertErr = null
    h.cfg.alertSentQueue = [null]
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const log = digestLog()
    expect(log.p_rows_written).toBe(1)
    expect(log.p_ok).toBe(true)
  })

  it("tolerates an alert_deliveries insert unique-violation (email went out, pipeline stays ok)", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    h.cfg.alertInsertErr = { message: "duplicate key value violates unique constraint" }
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const log = digestLog()
    expect(log.p_rows_written).toBe(1) // counted sent despite the delivery-record failure
    expect(log.p_ok).toBe(true)
  })
})

describe("weekly-digest — dry-run legs", () => {
  it("counts an already-sent recipient as skipped_already_sent, not would_send", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [{ unsubscribed_at: null, digest_weekly: true }] // preview read
    h.cfg.alertSentQueue = [{ id: "d1" }] // alreadySent → dedup
    const res = await call(await load(), "?dry=1")
    const body = await res.json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_already_sent).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns 500 ok:false when loadMovers fails in a dry run", async () => {
    h.cfg.moversError = "dry movers boom"
    const res = await call(await load(), "?dry=1")
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.dry).toBe(true)
  })
})
