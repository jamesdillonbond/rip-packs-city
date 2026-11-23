import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Deep-drive of /api/cron/weekly-digest's UNCOVERED silent-failure legs — the
// after() send-loop branches the happy-path sibling test never reaches. These
// are the retention-email's correctness contracts, and the after() body is the
// exact silent-run shape the 06-10/06-11 dark-run incidents came from (route
// answers 202, cron entry stays enabled, the work fails invisibly). Pinned:
//   - a transient send failure is RETRY-SAFE: skipped, its alert_deliveries claim RELEASED
//     written (so a later run this week retries), pipeline stays ok=true, and
//     the error string still surfaces in the log;
//   - loadMovers throwing inside after() → ok=false with a "threw:" error;
//   - a missing RESEND_API_KEY degrades to a per-send failure, not a hard crash;
//   - already-sent (dedup) + within-run duplicate email both skip without sending;
//   - an ensured-opt-out (digest_weekly=false) skips;
//   - a new subscriber gets a token inserted then sent;
//   - the delivery row is CLAIMED before the send (held / error → no send); a mark-sent error is tolerated;
//   - the dry-run already-sent + error(500) legs.

const h = vi.hoisted(() => ({
  cfg: {
    movers: [] as any[],
    moversError: null as string | null,
    emailSubQueue: [] as any[], // maybeSingle results for email_subscribers, in order
    alertSentQueue: [] as any[], // maybeSingle results for alert_deliveries (alreadySent), in order
    emailInsertErr: null as any,
    alertInsertErr: null as any,
    // 2026-11-02 claim-before-send: the claim upsert's returned rows / error.
    claimRows: undefined as any,
    claimErr: null as any,
    markErr: null as any,
    // 2026-11-22: portfolio_snapshots rows read by loadPackWeek (sealed packs in the Estimated value).
    packRows: undefined as any,
  },
  ops: [] as string[],
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
    b.delete = () => { op = "delete"; return b }
    const sel = async () => {
      if (table === "email_subscribers") return { data: shift(h.cfg.emailSubQueue), error: null }
      if (table === "alert_deliveries") return { data: shift(h.cfg.alertSentQueue), error: null }
      return { data: null, error: null }
    }
    b.maybeSingle = sel
    b.single = sel
    b.then = (resolve: any) => {
      h.ops.push(`${table}:${op}`)
      if (table === "alert_deliveries" && op === "upsert")
        return resolve({ data: h.cfg.claimErr ? null : (h.cfg.claimRows ?? [{ id: "claim-1" }]), error: h.cfg.claimErr })
      if (table === "alert_deliveries" && op === "update") return resolve({ data: null, error: h.cfg.markErr })
      if (table === "portfolio_snapshots") return resolve({ data: h.cfg.packRows ?? null, error: null })
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
      // 2026-11-22: the repricing read (lib/emails/weekly-repricing.ts); a test may override it.
      if (name === "get_weekly_repricing_impact") return (h.cfg as any).repricing ?? { data: { delta_usd: 0, editions: 0, moments: 0 }, error: null }
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin }
})

const TOKEN = "weekly-digest-ingest"
const mover = (over: Partial<Record<string, any>> = {}) => ({
  user_id: "u1", email: "A@B.com", latest_fmv: 100, prior_fmv: 90,
  delta_usd: 10, delta_pct: 11.11, moment_count: 5, latest_date: "2026-07-20", prior_date: "2026-07-13", ...over,
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
  h.cfg = { movers: [], moversError: null, emailSubQueue: [], alertSentQueue: [], emailInsertErr: null, alertInsertErr: null, claimRows: undefined, claimErr: null, markErr: null, packRows: undefined }
  h.ops = []
  h.rpcCalls = []
  h.afterFns = []
  process.env.INGEST_SECRET_TOKEN = TOKEN
  process.env.RPC_SENDER_POSTAL_ADDRESS = "PO Box 123, Portland, OR 97201"
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
  it("a Resend non-ok response skips the recipient, RELEASES its claim, keeps ok=true, surfaces the error", async () => {
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
    // claim-before-send (2026-11-02): the claim is released so a later run retries
    expect(h.ops).toContain("alert_deliveries:delete")
    expect(h.ops).not.toContain("alert_deliveries:update")
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

  // ⛔ CLAIM BEFORE SEND (2026-11-02): re-pinned from "tolerates an insert
  // unique-violation after the send" — the record is now a claim written FIRST.
  it("claims the week's row BEFORE sending, then marks it sent", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    let opsAtSend: string[] = []
    fetchMock.mockImplementationOnce(async () => { opsAtSend = [...h.ops]; return { ok: true, status: 200, text: async () => "" } as any })
    await call(await load())
    await h.afterFns[0]()
    expect(opsAtSend).toContain("alert_deliveries:upsert")
    expect(h.ops).not.toContain("alert_deliveries:insert")
    expect(h.ops).toContain("alert_deliveries:update")
    expect(digestLog().p_rows_written).toBe(1)
  })

  it("a claim another run holds (no row back) sends NOTHING", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    h.cfg.claimRows = []
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(digestLog().p_rows_written).toBe(0)
  })

  it("a claim write error sends NOTHING (fails closed) and surfaces the error", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    h.cfg.claimErr = { message: "claim boom" }
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(String(digestLog().p_error)).toContain("claim boom")
  })

  it("a mark-sent error is tolerated (email went out, pipeline stays ok)", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    h.cfg.markErr = { message: "mark boom" }
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const log = digestLog()
    expect(log.p_rows_written).toBe(1)
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

  // 2026-10-24: the weekly digest carries a plain-text part and RFC 8058 headers.
  it("sends a plain-text part, a reply-to and a one-click unsubscribe header", async () => {
    h.cfg.movers = [mover()]
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("Estimated value:")
    expect(body.text).toContain("/api/subscribe/unsubscribe?token=")
    expect(body.text).not.toMatch(/<[a-z]/i)
    expect(body.reply_to).toBe("rippackscity@gmail.com")
    expect(body.headers["List-Unsubscribe"]).toMatch(/^<https?:\/\/[^>]+\/api\/subscribe\/unsubscribe\?token=[^>]+>$/)
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
  })
})

describe("weekly digest — never mails an invented figure (2026-11-03)", () => {
  // The formatters used to default a missing value: "$0.00", "0%" (in the SUBJECT) and
  // "0 moments tracked". A mover missing a printed figure is now skipped and counted.
  beforeEach(() => {
    h.cfg.emailSubQueue = [withToken]
    h.cfg.alertSentQueue = [null]
  })

  for (const field of ["latest_fmv", "delta_usd", "delta_pct"] as const) {
    it(`skips (does not mail) a mover whose ${field} is null, and counts it`, async () => {
      h.cfg.movers = [mover({ [field]: null })]
      await call(await load())
      await h.afterFns[0]()
      expect(fetchMock).not.toHaveBeenCalled()
      const log = digestLog()
      expect(log.p_extra.skipped_incomplete).toBe(1)
      expect(log.p_rows_written).toBe(0)
    })
  }

  it("the dry run reports the same skip — it does not list an incomplete mover as would_send", async () => {
    h.cfg.movers = [mover({ delta_pct: null })]
    h.cfg.emailSubQueue = [{ unsubscribed_at: null, digest_weekly: true }]
    const res = await call(await load(), "?dry=1")
    const body = await res.json()
    expect(body.would_send).toBe(0)
    expect(body.skipped_incomplete).toBe(1)
  })

  it("a complete mover is mailed with real figures, the holdings note, and no '0 moments' when the count is unread", async () => {
    h.cfg.movers = [mover({ moment_count: null })]
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.subject).toContain("+11.11%")
    expect(body.text).toContain("$100.00")
    expect(body.text).toContain("Includes any moments you added or sold this week.")
    expect(body.text).not.toMatch(/\b0 moments tracked/)
    expect(body.html).not.toMatch(/\b0 moments tracked/)
    expect(digestLog().p_extra.skipped_incomplete).toBe(0)
  })

  // 2026-11-22, before the first send: the 11-17 FMV restatements made two members' week read "−49.6 %",
  // most of it our own price correction. The email states the repricing part; a failed read is not "none".
  // 2026-11-22 evening (Trevor: one number for everything in the wallet, "Yes proceed" to the email).
  it("the Estimated value includes sealed packs; with no comparable pack prior the change says it covers the moments", async () => {
    h.cfg.movers = [mover()]
    h.cfg.packRows = [{ snapshot_date: "2026-11-30", pack_low_ask_usd: "50", pack_held_count: 2, pack_listed_count: 2, pack_value_basis: null }]
    await call(await load())
    await h.afterFns[0]()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("Estimated value: $150.00")
    expect(body.text).toContain("this week on your moments")
    expect(body.text).toContain("Sealed packs (included above): $50.00")
    expect(body.text).not.toContain("not in the value above")
    expect(body.subject).toBe("Your Rip Packs City portfolio this week")
  })

  it("with a like-for-like pack prior the change and the subject % cover moments + packs", async () => {
    h.cfg.movers = [mover()]
    h.cfg.packRows = [
      { snapshot_date: "2026-11-30", pack_low_ask_usd: "50", pack_held_count: 2, pack_listed_count: 2, pack_value_basis: null },
      { snapshot_date: "2026-11-23", pack_low_ask_usd: "40", pack_held_count: 2, pack_listed_count: 2, pack_value_basis: null },
    ]
    await call(await load())
    await h.afterFns[0]()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("Estimated value: $150.00")
    // moments +10 (90 -> 100) + packs +10 (40 -> 50) = +20 on a prior total of 130
    expect(body.text).toContain("Up $20.00 (+15.38%) this week")
    expect(body.text).not.toContain("on your moments")
    expect(body.subject).toContain("+15.38%")
  })

  it("states how much of the move is our repricing, and the subject drops the % when repricing dominates", async () => {
    h.cfg.movers = [mover({ latest_fmv: 38184, prior_fmv: 75803, delta_usd: -37619, delta_pct: -49.63 })]
    ;(h.cfg as any).repricing = { data: { delta_usd: -27587.25, editions: 18, moments: 36 }, error: null }
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("Includes about −$27,587.25 from our price corrections on 18 of your editions this week — not market moves.")
    expect(body.html).toContain("from our price corrections on 18 of your editions")
    expect(body.subject).toBe("Your Rip Packs City portfolio this week")
    expect(body.subject).not.toContain("49.6")
    const call0 = h.rpcCalls.find((c: any) => c.name === "get_weekly_repricing_impact")
    expect(call0?.args).toEqual({ p_owner_key: "u1", p_prior_date: "2026-07-13", p_latest_date: "2026-07-20" })
  })

  it("a small repricing share keeps the % subject and still discloses the part", async () => {
    h.cfg.movers = [mover({ delta_usd: -4251, delta_pct: -38.8 })]
    ;(h.cfg as any).repricing = { data: { delta_usd: -179.1, editions: 1, moments: 1 }, error: null }
    await call(await load())
    await h.afterFns[0]()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.subject).toContain("-38.8")
    expect(body.text).toContain("on 1 of your editions this week")
  })

  it("no repricing in the window prints no line", async () => {
    h.cfg.movers = [mover()]
    await call(await load())
    await h.afterFns[0]()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).not.toContain("price corrections")
  })

  it("a failed repricing read skips the member (incomplete), never a bare delta", async () => {
    h.cfg.movers = [mover({ delta_usd: -37619, delta_pct: -49.63 })]
    ;(h.cfg as any).repricing = { data: null, error: { message: "boom" } }
    await call(await load())
    await h.afterFns[0]()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(digestLog().p_extra.skipped_incomplete).toBe(1)
  })

  it("prints the moment count when it was read", async () => {
    h.cfg.movers = [mover({ moment_count: 1860 })]
    await call(await load())
    await h.afterFns[0]()
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("1,860 moments tracked")
  })
})
