import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET/POST /api/cron/alerts-send — the per-channel outbox sender.
// Pins the delivery-accounting contracts that must hold when a channel is down:
//   - a healthy tick claims a batch, digests per-recipient into ONE send, marks
//     every row sent, and logs rows_written=sent / rows_skipped=failed;
//   - a DEAD channel (missing token / upstream 5xx) marks every row FAILED and
//     NEVER marks it sent — the run stays ok=true (rows re-queue) but failed>0;
//   - two deliveries to the same target collapse into one digest send;
//   - ?channel= scopes the drain to a single channel;
//   - a claim throw flips the run ok=false so the monitor sees it;
//   - the auth guard.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  claim: {} as Record<string, unknown[]>, // channel -> deliveries
  claimThrow: null as string | null,
  sent: [] as string[],
  failed: [] as Array<{ id: string; msg: string }>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

// The route builds its client via createClient at module load.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

// Mock the alerts lib seam so we control claim + observe sent/failed marking.
vi.mock("@/lib/alerts", () => ({
  CHANNELS: ["email", "telegram", "discord"],
  claimPendingDeliveries: async (channel: string) => {
    if (state.claimThrow) throw new Error(state.claimThrow)
    const deliveries = state.claim[channel] ?? []
    return { channel, count: deliveries.length, deliveries }
  },
  markDeliverySent: async (id: string) => void state.sent.push(id),
  markDeliveryFailed: async (id: string, msg: string) => void state.failed.push({ id, msg }),
}))

// Real formatters are pure; stub them so a body shape never trips the test.
vi.mock("@/lib/alerts/format", () => ({
  buildEmailMessage: () => ({ subject: "s", html: "<b>h</b>", text: "t" }),
  buildTelegramMessage: () => "tg text",
  buildDiscordEmbeds: () => [{ title: "e" }],
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"

const { GET } = await import("@/app/api/cron/alerts-send/route")

function delivery(id: string, channel: string, target: string) {
  return { id, channel, channel_user_id: target, owner_key: "o", alert_kind: "deal", status: "sending", attempts: 0, payload: {} }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install() {
  const spy = makeInstrumentedSupabaseFixture({ "rpc:log_pipeline_run": { data: null, error: null } })
  state.sb = spy.fixture
  return spy
}

function req(channel?: string): NextRequest {
  const q = channel ? `?channel=${channel}` : ""
  return new NextRequest(`https://t/api/cron/alerts-send${q}`, {
    method: "GET",
    headers: new Headers({ authorization: "Bearer alerts-send-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
function stubFetch(stubs: FetchStub[]) {
  fetchMock = installFetchMock(stubs)
  return fetchMock
}
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
  state.claim = {}
  state.claimThrow = null
  state.sent = []
  state.failed = []
  process.env.INGEST_SECRET_TOKEN = "alerts-send-token"
  process.env.RESEND_API_KEY = "re-key"
  process.env.TELEGRAM_USER_BOT_TOKEN = "tg-user-token"
  process.env.DISCORD_BOT_TOKEN = "disc-token"
})

describe("alerts-send — every outbound delivery call is time-bounded", () => {
  // 🚨 WHY THIS ROUTE ESPECIALLY. An alert dispatcher's output is SILENCE, so a
  // hung delivery is the least falsifiable failure on the platform — CLAUDE.md
  // names it the worst sub-class. `fetch()` has no default timeout, this work
  // runs in `after()` under maxDuration 60, and a maxDuration kill writes NO
  // terminal row: "no alerts sent" would be indistinguishable from "no alerts to
  // send".
  //
  // ⚠ Measured, not speculative: over 48h this pipeline ran 276 times with an
  // avg of 1,494ms and a p95 of 1,644ms — and a max of 58,670ms against the
  // 60,000ms ceiling. A route with a 1.6s p95 does not take 58.7s for a normal
  // reason; that outlier came within 1.3 SECONDS of a kill.
  //
  // ⚠ Asserted on the REQUEST INIT, not the source text — a source grep would be
  // satisfied by the comment you are reading.
  it.each([
    ["email", "api.resend.com", { id: "e1" }],
    ["telegram", "api.telegram.org", { ok: true }],
  ] as const)("%s delivery passes an abort signal", async (channel, host, body) => {
    state.claim = { [channel]: [delivery("d1", channel, "target-1")] } as never
    install()
    const f = stubFetch([jsonRoute(host, body)])

    await GET(req(channel))
    await runDeferred()

    const calls = f.calls.filter((c) => c.url.includes(host))
    // Not vacuous: a run that sent nothing would assert nothing below.
    expect(calls.length).toBeGreaterThan(0)
    const unbounded = calls.filter((c) => !c.init?.signal).map((c) => c.url)
    expect(
      unbounded,
      `every ${channel} delivery must carry an AbortSignal — an unbounded one ` +
        `consumes the whole 60s tick and the run dies without a terminal row`,
    ).toEqual([])
  })

  it("discord delivery passes an abort signal on BOTH the DM-open and the message call", async () => {
    // Discord takes two hops, and the first one (opening the DM channel) is the
    // one a per-send timeout is easiest to forget.
    state.claim = { discord: [delivery("d1", "discord", "user-9")] }
    install()
    const f = stubFetch([jsonRoute("discord.com", { id: "dm-1" })])

    await GET(req("discord"))
    await runDeferred()

    const calls = f.calls.filter((c) => c.url.includes("discord.com"))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const unbounded = calls.filter((c) => !c.init?.signal).map((c) => c.url)
    expect(unbounded, "both Discord hops must be bounded").toEqual([])
  })
})

describe("alerts-send — healthy drain", () => {
  it("digests one email recipient, marks the row sent, and logs written=sent", async () => {
    state.claim = { email: [delivery("d1", "email", "user@example.com")] }
    const spy = install()
    const f = stubFetch([jsonRoute("api.resend.com", { id: "e1" })])

    const res = await GET(req("email"))
    expect(res.status).toBe(202)
    await runDeferred()

    expect(f.calls.some((c) => c.url.includes("api.resend.com"))).toBe(true)
    expect(state.sent).toEqual(["d1"])
    expect(state.failed).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "alerts-send", p_ok: true, p_rows_found: 1, p_rows_written: 1, p_rows_skipped: 0 })
    expect(log.p_extra).toMatchObject({ sent: 1, failed: 0, channels: ["email"] })
  })

  it("collapses two deliveries to the same target into ONE digest send", async () => {
    state.claim = {
      telegram: [delivery("d1", "telegram", "chat-9"), delivery("d2", "telegram", "chat-9")],
    }
    const spy = install()
    const f = stubFetch([jsonRoute("api.telegram.org", { ok: true })])

    await GET(req("telegram"))
    await runDeferred()

    // One HTTP send for the group; both rows marked sent.
    expect(f.calls.filter((c) => c.url.includes("api.telegram.org"))).toHaveLength(1)
    expect(state.sent.sort()).toEqual(["d1", "d2"])
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 2, p_ok: true })
  })
})

describe("alerts-send — dead channel accounting", () => {
  it("a 5xx from the sender marks the row FAILED and never claims it sent (rows re-queue)", async () => {
    state.claim = { email: [delivery("d1", "email", "user@example.com")] }
    const spy = install()
    stubFetch([jsonRoute("api.resend.com", { error: "boom" }, { status: 500 })])

    await GET(req("email"))
    await runDeferred()

    expect(state.sent).toHaveLength(0) // NEVER falsely claim delivery
    expect(state.failed).toHaveLength(1)
    expect(state.failed[0].id).toBe("d1")
    expect(state.failed[0].msg).toContain("resend 500")

    const log = terminalLog(spy.rpcCalls)
    // A failed send is NOT a pipeline failure (rows re-queue) — ok stays true,
    // but the failure is surfaced in the counts + extra so the monitor sees it.
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    expect(log.p_extra).toMatchObject({ sent: 0, failed: 1 })
  })

  it("a missing channel token surfaces as a per-row FAILED with the missing-secret reason", async () => {
    delete process.env.TELEGRAM_USER_BOT_TOKEN
    state.claim = { telegram: [delivery("d1", "telegram", "chat-9")] }
    const spy = install()
    stubFetch([jsonRoute("api.telegram.org", { ok: true })])

    await GET(req("telegram"))
    await runDeferred()

    expect(state.sent).toHaveLength(0)
    expect(state.failed[0].msg).toContain("TELEGRAM_USER_BOT_TOKEN missing")
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: true, p_rows_skipped: 1 })
  })
})

describe("alerts-send — scope + fatal + auth", () => {
  it("?channel=discord scopes the drain to one channel", async () => {
    state.claim = {
      email: [delivery("dE", "email", "user@example.com")],
      discord: [delivery("dD", "discord", "disc-user")],
    }
    const spy = install()
    stubFetch([
      jsonRoute("discord.com/api/v10/users/@me/channels", { id: "dm-1" }),
      jsonRoute("discord.com/api/v10/channels/dm-1/messages", { id: "m-1" }),
    ])

    await GET(req("discord"))
    await runDeferred()

    // Only discord drained -> its delivery sent, email untouched.
    expect(state.sent).toEqual(["dD"])
    expect(terminalLog(spy.rpcCalls).p_extra).toMatchObject({ channels: ["discord"] })
  })

  it("a claim throw flips the run ok=false so a stuck outbox is visible", async () => {
    state.claim = {}
    state.claimThrow = "claim_pending_deliveries deadlock"
    const spy = install()
    stubFetch([jsonRoute("api.resend.com", { id: "e1" })])

    await GET(req("email"))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("email: claim_pending_deliveries deadlock")
  })

  it("401s without the bearer token and runs nothing", async () => {
    install()
    const res = await GET(new NextRequest("https://t/api/cron/alerts-send", { method: "GET" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
