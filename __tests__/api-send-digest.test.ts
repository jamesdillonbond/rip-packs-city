import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/send-digest. Bearer-gated with
// INGEST_SECRET_TOKEN read into a module-level TOKEN at IMPORT time, so the env
// must be set BEFORE importing the route. Fail-closed: no/wrong header → 401.
// supabaseAdmin (@/lib/supabase) is mocked; happy path uses an empty subscriber
// list so no Resend fetch is made → {subscribers:0, sent:0, errors:0}. Error on
// the subscriber query → 500.

const state: { result: any; rpc: Record<string, any>; rpcCalls: Array<{ name: string; args: any }>; dedup: any; inserts: any[]; claims: any[]; claim: any; updates: any[]; deletes: number } = { result: { data: [], error: null }, rpc: {}, rpcCalls: [], dedup: { data: null, error: null }, inserts: [], claims: [], claim: null, updates: [], deletes: 0 }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    is: () => b,
    // alert_deliveries: the per-week dedup read and the post-send record.
    maybeSingle: async () => state.dedup,
    insert: async (row: any) => { state.inserts.push(row); return { error: null } },
    // 2026-11-02 claim-before-send: the week's row is claimed (insert-only on the
    // unique key) BEFORE Resend, marked sent after, released if the send fails.
    upsert: (row: any) => { state.claims.push(row); return { select: async () => state.claim ?? { data: [{ id: "claim-1" }], error: null } } },
    update: (row: any) => { state.updates.push(row); return { eq: async () => ({ error: null }) } },
    delete: () => ({ eq: async () => { state.deletes += 1; return { error: null } } }),
    then: (resolve: any) => resolve(state.result),
  }
  const admin: any = {
    from: () => b,
    rpc: async (name: string, args?: any) => { state.rpcCalls.push({ name, args }); return state.rpc[name] ?? { data: null, error: null } },
  }
  return { supabaseAdmin: admin }
})

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET } = await import("@/app/api/send-digest/route")

function req(auth?: string, url = "https://t/api/send-digest") {
  return { headers: new Headers(auth ? { authorization: auth } : {}), url } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  // 2026-10-18: the route sends only with its flag AND the CAN-SPAM postal address.
  process.env.SEND_DIGEST_ENABLED = "1"
  process.env.RPC_SENDER_POSTAL_ADDRESS = "PO Box 123, Portland, OR 97201"
  state.result = { data: [], error: null }
  state.rpc = {}
  state.dedup = { data: null, error: null }
  state.inserts = []
  state.claims = []
  state.claim = null
  state.updates = []
  state.deletes = 0
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  delete process.env.RESEND_API_KEY
  delete process.env.SEND_DIGEST_ENABLED
  delete process.env.RPC_SENDER_POSTAL_ADDRESS
  vi.unstubAllGlobals()
})

// One verified subscriber with a wallet + rich RPC data so buildEmail composes
// portfolio + deals + pulse blocks.
function seedOneSubscriber() {
  state.result = { data: [{ email: "a@b.com", wallet_address: "0xAbC", verification_token: "vt1" }], error: null }
  state.rpc.get_cross_collection_portfolio = { data: { total_fmv: 1234, collection_count: 2, total_moments: 9, total_pnl: 50, collections: [{}, {}] }, error: null }
  state.rpc.get_market_pulse_all = { data: { topshot: { vol: 1 } }, error: null }
  state.rpc.get_cross_collection_deals = { data: { deals: [{ player_name: "Luka", ask_price: 8, discount: 40 }] }, error: null }
}

describe("GET /api/send-digest", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong"))).status).toBe(401)
  })

  // 2026-10-18: this route had no enable flag; anything holding the bearer token
  // mailed every verified subscriber a commercial digest with no postal address.
  it("sends NOTHING and reads no subscriber when its flag is off", async () => {
    delete process.env.SEND_DIGEST_ENABLED
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ sent: 0, skipped: "flag_off" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends NOTHING when enabled but the CAN-SPAM postal address is missing", async () => {
    delete process.env.RPC_SENDER_POSTAL_ADDRESS
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ sent: 0, skipped: "postal_address_missing" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a sent digest carries the postal address in its footer", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).toContain("PO Box 123, Portland, OR 97201")
  })

  // 2026-11-02: total_pnl covers only moments with a KNOWN purchase price and starts at 0, so a holder with no
  // known cost was mailed "P&L: +$0.00". Assert the ABSENCE of that claim, and the scoped label when it shows.
  it("prints NO P&L line when no cost basis is known (never a fabricated +$0.00)", async () => {
    seedOneSubscriber()
    state.rpc.get_cross_collection_portfolio = { data: { total_fmv: 1234, collection_count: 2, total_moments: 9, total_pnl: 0, total_cost_basis: 0, collections: [{}, {}] }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).not.toContain("P&L")
    expect(body.text).not.toContain("P&L")
  })

  it("prints P&L scoped to moments with a known purchase price when cost basis exists", async () => {
    seedOneSubscriber()
    state.rpc.get_cross_collection_portfolio = { data: { total_fmv: 1234, collection_count: 2, total_moments: 9, total_pnl: 50, total_cost_basis: 400, collections: [{}, {}] }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).toContain("+$50.00 on moments with a known purchase price")
  })

  it("returns a zeroed summary when there are no subscribers", async () => {
    state.result = { data: [], error: null }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ subscribers: 0, sent: 0, errors: 0, already_sent_this_week: 0, market_reads_failed: [] })
  })

  it("500s on a subscriber-query error", async () => {
    state.result = { data: null, error: { message: "db down" } }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("composes + sends a digest via Resend and counts it sent", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }))
    vi.stubGlobal("fetch", fetchSpy as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subscribers: 1, sent: 1, errors: 0, already_sent_this_week: 0, market_reads_failed: [] })
    // the Resend call carried the composed HTML
    const firstCall = fetchSpy.mock.calls[0] as any[]
    const callBody = JSON.parse(firstCall[1].body)
    expect(callBody.to).toBe("a@b.com")
    expect(callBody.html).toContain("Weekly Digest")
    expect(callBody.html).toContain("Luka") // deals block
  })

  it("counts an error (does not send) when RESEND_API_KEY is unset", async () => {
    seedOneSubscriber()
    delete process.env.RESEND_API_KEY
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1, already_sent_this_week: 0, market_reads_failed: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("counts an error on a non-ok Resend response", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, text: async () => "bad" })) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1, already_sent_this_week: 0, market_reads_failed: [] })
  })

  it("counts an error when the Resend fetch throws", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network") }) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 0, errors: 1, already_sent_this_week: 0, market_reads_failed: [] })
  })

  it("handles a subscriber with no wallet (skips the portfolio RPC) and still sends", async () => {
    state.result = { data: [{ email: "c@d.com", wallet_address: null, verification_token: null }], error: null }
    state.rpc.get_market_pulse_all = { data: null, error: null }
    state.rpc.get_cross_collection_deals = { data: { deals: [] }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" })) as any)
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toEqual({ subscribers: 1, sent: 1, errors: 0, already_sent_this_week: 0, market_reads_failed: [] })
  })
})

// ⛔ THE HIGHEST-REACH SURFACE THIS CLASS REACHES: an outbound email.
// `get_cross_collection_portfolio` on a folded base58 wallet returns a
// structurally COMPLETE object of zeros, and buildEmail gates the portfolio
// block on `collections?.length` — so a Candy holder's weekly digest silently
// dropped their entire portfolio. 📏 Measured live 2026-09-19: correct key →
// total_fmv 19,386.54; lowercased → total_fmv 0.00, collections [], and the RPC
// echoes the mangled wallet back so the answer looks true.
describe("send-digest — a Candy subscriber's wallet is not folded", () => {
  const MINT = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"

  it("passes base58 through CASE-INTACT", async () => {
    state.rpcCalls = []
    state.result = { data: [{ email: "c@d.com", wallet_address: MINT, verification_token: "vt" }], error: null }
    await GET(req(`Bearer ${TOKEN}`))
    const call = state.rpcCalls.find((c) => c.name === "get_cross_collection_portfolio")
    expect(call?.args?.p_wallet).toBe(MINT)
  })

  it("no-change control: a Flow subscriber's wallet is still folded", async () => {
    state.rpcCalls = []
    state.result = { data: [{ email: "a@b.com", wallet_address: "0xAbCDEF1234567890", verification_token: "vt1" }], error: null }
    await GET(req(`Bearer ${TOKEN}`))
    const call = state.rpcCalls.find((c) => c.name === "get_cross_collection_portfolio")
    expect(call?.args?.p_wallet).toBe("0xabcdef1234567890")
  })
})

// 2026-10-10: every read discarded its error, so a failed read silently dropped
// its block — a holder got a digest without their portfolio, and with every read
// failing, every subscriber got an empty digest.
describe("GET /api/send-digest — a failed read never ships as an emptier email", () => {
  it("both market reads failing aborts the run before any send (503)", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    state.rpc.get_market_pulse_all = { data: null, error: { message: "timeout" } }
    state.rpc.get_cross_collection_deals = { data: null, error: { message: "timeout" } }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ONE market read failing also aborts — no digest silently missing a block", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    state.rpc.get_cross_collection_deals = { data: null, error: { message: "timeout" } }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a subscriber whose portfolio read fails is skipped, not mailed a digest without it", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    state.rpc.get_cross_collection_portfolio = { data: null, error: { message: "timeout" } }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(await res.json()).toMatchObject({ subscribers: 1, sent: 0, errors: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 2026-10-24: text part, one-click unsubscribe, readable pulse, escaped names.
  it("sends a plain-text part, a reply-to and an RFC 8058 one-click unsubscribe header", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.text).toContain("Weekly Digest")
    expect(body.text).toContain("Luka")
    expect(body.text).toContain("PO Box 123, Portland, OR 97201")
    expect(body.text).toContain("/api/subscribe/unsubscribe?token=vt1")
    expect(body.text).not.toMatch(/<[a-z]/i)
    expect(body.reply_to).toBe("rippackscity@gmail.com")
    expect(body.headers["List-Unsubscribe"]).toMatch(/^<https?:\/\/[^>]+\/api\/subscribe\/unsubscribe\?token=vt1>$/)
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
  })

  it("renders the market pulse as lines, never raw JSON, and omits collections with no recorded sales", async () => {
    seedOneSubscriber()
    state.rpc.get_market_pulse_all = {
      data: [
        { collection_name: "NBA Top Shot", sales_24h: 2699, volume_24h: 8865.78 },
        { collection_name: "Candy MLB", sales_24h: 0, volume_24h: 0 },
      ],
      error: null,
    }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).toContain("NBA Top Shot")
    expect(body.html).toContain("2,699 sales")
    expect(body.html).not.toContain("<pre")
    expect(body.html).not.toContain('"sales_24h"')
    expect(body.html).not.toContain("Candy MLB") // a frozen feed must not print as "0 sales"
    expect(body.text).toContain("NBA Top Shot: 2,699 sales")
  })

  it("escapes database text before it goes into the HTML", async () => {
    seedOneSubscriber()
    state.rpc.get_cross_collection_deals = { data: { deals: [{ player_name: "<img src=x onerror=alert(1)>", ask_price: 8, discount: 40 }] }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).not.toContain("<img src=x")
    expect(body.html).toContain("&lt;img src=x")
  })

  it("omits the one-click header when the subscriber has no token (no URL to post to)", async () => {
    seedOneSubscriber()
    state.result = { data: [{ email: "a@b.com", wallet_address: "0xAbC", verification_token: null }], error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.headers).toBeUndefined()
    expect(body.text).toContain("Unsubscribe:")
  })

  // 2026-11-02 (Stage B): a Vercel cron can re-fire, and an operator may run it by hand.
  it("never mails a subscriber twice in one week", async () => {
    seedOneSubscriber()
    state.dedup = { data: { id: 1 }, error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(body.sent).toBe(0)
    expect(body.already_sent_this_week).toBe(1)
  })

  it("an unreadable dedup row refuses the send (fails closed)", async () => {
    seedOneSubscriber()
    state.dedup = { data: null, error: { message: "db" } }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(body.errors).toBe(1)
  })

  it("claims the week's row BEFORE sending, then marks it sent", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    let claimsAtSend = -1
    vi.stubGlobal("fetch", vi.fn(async () => { claimsAtSend = state.claims.length; return { ok: true } as any }))
    await GET(req(`Bearer ${TOKEN}`))
    expect(claimsAtSend).toBe(1)
    expect(state.claims[0]).toMatchObject({ owner_key: "a@b.com", status: "sending", alert_kind: "weekly_digest" })
    expect(state.updates).toEqual([expect.objectContaining({ status: "sent" })])
    expect(state.deletes).toBe(0)
  })

  it("a claim another run already holds (no row returned) sends nothing", async () => {
    seedOneSubscriber()
    state.claim = { data: [], error: null }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(body.sent).toBe(0)
    expect(body.already_sent_this_week).toBe(1)
  })

  it("an errored claim refuses the send (fails closed)", async () => {
    seedOneSubscriber()
    state.claim = { data: null, error: { message: "db" } }
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(body.errors).toBe(1)
  })

  it("a failed send RELEASES the claim so next week's rerun can retry", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as any))
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json()
    expect(body.sent).toBe(0)
    expect(state.deletes).toBe(1)
    expect(state.updates).toEqual([])
  })

  it("a dry run sends nothing, even with its flag off, and returns no addresses", async () => {
    delete process.env.SEND_DIGEST_ENABLED
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await GET(req(`Bearer ${TOKEN}`, "https://t/api/send-digest?dry=1"))
    const text = await res.text()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text).not.toContain("a@b.com")
    expect(JSON.parse(text)).toMatchObject({ dry: true, blocked: "flag_off", subscribers: 1, would_send: 1 })
  })

  it("accepts the Vercel cron secret", async () => {
    process.env.CRON_SECRET = "cron-s"
    const res = await GET(req("Bearer cron-s"))
    expect(res.status).toBe(200)
    delete process.env.CRON_SECRET
  })

  it("links point at the public site, not the host the request arrived on", async () => {
    seedOneSubscriber()
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn(async () => ({ ok: true }) as any)
    vi.stubGlobal("fetch", fetchMock)
    await GET(req(`Bearer ${TOKEN}`, "https://rpc-abc123.vercel.app/api/send-digest"))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))
    expect(body.html).not.toContain("vercel.app")
    expect(body.html).toContain("/api/subscribe/unsubscribe?token=vt1")
  })
})
