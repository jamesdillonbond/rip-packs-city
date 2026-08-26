import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep test for GET /api/check-alerts — drives the deferred alert sweep
// (pipeline-health notify with 60-min debounce + FMV alert emails with 6h
// cooldown) by capturing after(). Pins the alerting contracts that matter when
// everything else is on fire:
//   - hot alerts actually reach both channels and stamp the debounce record;
//   - a debounced alert set sends NOTHING;
//   - all-channels-failed does NOT stamp the debounce (so the next tick retries)
//     and the run logs ok=false;
//   - a throw anywhere still writes a pipeline_runs row (the 2026-06-11 class).

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// Module-level consts read these at import time.
process.env.INGEST_SECRET_TOKEN = "alerts-token"
process.env.RESEND_API_KEY = "re-key"
process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "12345"
process.env.ALERT_EMAIL = "ops@example.com"

const { GET } = await import("@/app/api/check-alerts/route")

function reqAuthed(): NextRequest {
  return new NextRequest("https://t/api/check-alerts", {
    method: "GET",
    headers: new Headers({ authorization: "Bearer alerts-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install(fixtures: Fixtures, opts?: { failWrites?: string[] }) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

const telegramOk = jsonRoute("api.telegram.org", { ok: true })
const resendOk = jsonRoute("api.resend.com", { id: "email-1" })

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
})

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

const HOT_ALERTS = [
  { type: "cron_silent", detail: "no runs in 90m", pipeline: "topshot-sales-indexer", severity: "critical" },
  { type: "fail_streak", detail: "5 consecutive fails", pipeline: "wmc-fmv-populate", severity: "high" },
  { type: "slow", detail: "p95 rising", pipeline: "offers-sweep", severity: "info" },
]

const NO_FMV_TRIGGERS = { "rpc:check_triggered_fmv_alerts": { data: { total_triggered: 0, triggered_alerts: [] }, error: null } }

describe("GET /api/check-alerts — deferred sweep", () => {
  it("202-acks, notifies both channels on hot alerts, stamps the debounce record, logs ok=true", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: HOT_ALERTS, error: null },
      alert_notifications_sent: { data: null, error: null }, // no prior send in window
      ...NO_FMV_TRIGGERS,
    })
    const f = stubFetch([telegramOk, resendOk])

    const res = await GET(reqAuthed())
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    await runDeferred()

    // Both channels hit. Only critical+high (2 of 3) alerts are in the payload.
    const tgCall = f.calls.find((c) => c.url.includes("api.telegram.org"))
    expect(tgCall).toBeTruthy()
    const tgBody = JSON.parse(String(tgCall!.init?.body))
    expect(tgBody.text).toContain("topshot-sales-indexer")
    expect(tgBody.text).toContain("wmc-fmv-populate")
    expect(tgBody.text).not.toContain("offers-sweep")
    expect(f.calls.some((c) => c.url.includes("api.resend.com"))).toBe(true)

    // Debounce record stamped with the hot count + severity rollup.
    const stamp = writes.alert_notifications_sent?.find((w) => w.method === "upsert")
    expect(stamp?.rows[0]).toMatchObject({ severity: "critical", pipeline_count: 2 })

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "check-alerts", p_ok: true, p_rows_written: 2 })
  })

  it("a debounced alert set sends nothing and reports debounced", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: HOT_ALERTS, error: null },
      alert_notifications_sent: {
        data: { alert_hash: "x", sent_at: new Date().toISOString() },
        error: null,
      },
      ...NO_FMV_TRIGGERS,
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    expect(f.calls.filter((c) => c.url.includes("telegram") || c.url.includes("resend"))).toHaveLength(0)
    expect(writes.alert_notifications_sent ?? []).toHaveLength(0)
    const log = terminalLog(rpcCalls)
    expect((log?.p_extra as { pipeline_alerts?: { debounced?: boolean } })?.pipeline_alerts?.debounced).toBe(true)
    expect(log?.p_ok).toBe(true)
  })

  it("all-channels-failed does NOT stamp the debounce record and logs ok=false (next tick retries)", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: HOT_ALERTS, error: null },
      alert_notifications_sent: { data: null, error: null },
      ...NO_FMV_TRIGGERS,
    })
    stubFetch([
      jsonRoute("api.telegram.org", { ok: false }, { status: 500 }),
      jsonRoute("api.resend.com", { error: "boom" }, { status: 500 }),
    ])

    await GET(reqAuthed())
    await runDeferred()

    // No debounce stamp -> the same alert set will re-attempt next tick.
    expect(writes.alert_notifications_sent ?? []).toHaveLength(0)
    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("all channels failed")
  })

  it("FMV alerts: cooldown skips, fresh triggers email + stamp last_triggered_at", async () => {
    const now = Date.now()
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": {
        data: {
          total_triggered: 2,
          triggered_alerts: [
            {
              alert_id: "a-cooling",
              player_name: "Damian Lillard",
              alert_type: "below_price",
              threshold: 25,
              notification_email: "user@example.com",
              channel: "email",
              last_triggered_at: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago < 6h cooldown
            },
            {
              alert_id: "a-fresh",
              player_name: "Scoot Henderson",
              alert_type: "below_fmv_pct",
              threshold: 25,
              notification_email: "user@example.com",
              channel: "both",
              last_triggered_at: null,
              lowest_ask: 12.5,
              current_fmv: 20,
            },
          ],
        },
        error: null,
      },
      fmv_alerts: { data: null, error: null },
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    // Exactly one email (the fresh alert); the cooling one is skipped.
    const emails = f.calls.filter((c) => c.url.includes("api.resend.com"))
    expect(emails).toHaveLength(1)
    const emailBody = JSON.parse(String(emails[0].init?.body))
    expect(emailBody.subject).toContain("Scoot Henderson")
    expect(emailBody.html).toContain("Discount vs FMV reached 25% or more")

    // The fresh alert's last_triggered_at is stamped.
    expect(writes.fmv_alerts?.some((w) => w.method === "update")).toBe(true)

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "check-alerts", p_ok: true, p_rows_skipped: 1, p_rows_written: 1 })
  })

  it("a throw inside the sweep still writes a pipeline_runs row (2026-06-11 fatal-catch class)", async () => {
    const { rpcCalls } = install(
      {
        "rpc:get_pipeline_alerts": { data: [], error: null },
        "rpc:check_triggered_fmv_alerts": {
          data: {
            total_triggered: 1,
            triggered_alerts: [
              {
                alert_id: "a-1",
                player_name: "X",
                alert_type: "below_price",
                threshold: 5,
                notification_email: null,
                channel: "email",
                last_triggered_at: null,
              },
            ],
          },
          error: null,
        },
      },
      { failWrites: ["fmv_alerts"] },
    )
    stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("fatal:")
    expect((log?.p_extra as { fatal?: boolean })?.fatal).toBe(true)
  })

  it("401s without the bearer token and runs nothing", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/check-alerts"))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})

describe("GET /api/check-alerts — pipeline-alert edge branches", () => {
  it("get_pipeline_alerts error logs ok=false and still runs the FMV leg", async () => {
    const { rpcCalls } = install({
      "rpc:get_pipeline_alerts": { data: null, error: { message: "gpa boom" } },
      ...NO_FMV_TRIGGERS,
    })
    stubFetch([telegramOk, resendOk])

    const res = await GET(reqAuthed())
    expect(res.status).toBe(202)
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("gpa boom")
  })

  // ── FAIL CLOSED ON SHAPE — the alert whose failure output is SILENCE ───────
  //
  // get_pipeline_alerts returns scalar `jsonb` (pg_proc, not SETOF), so `data`
  // is whatever that jsonb is. The route read `Array.isArray(data) ? data : []`,
  // which turned ANY non-array into an EMPTY alert list. An empty list means
  // hot.length === 0, so the route sent NOTHING, recorded alerts_active: 0, and
  // logged p_ok: TRUE — because p_ok is `!pipelineAlerts.error` and the coercion
  // sets no error. An unreadable payload rendered as "nothing is wrong" on the
  // one instrument whose whole job is to say when something is.
  //
  // ⚠ Asserted on p_ok and on SILENCE, not on copy: the pre-fix route produced
  // no error string at all, so any assertion about wording would have passed
  // against the defect. The load-bearing claims are (a) it does not report ok
  // and (b) it does not quietly send nothing while claiming health.
  it.each([
    ["object", { alerts: [] }],
    ["null", null],
    ["scalar", 0],
  ])("a non-array get_pipeline_alerts payload (%s) logs ok=false and never reports a clean sweep", async (_label, payload) => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: payload, error: null },
      ...NO_FMV_TRIGGERS,
    })
    const f = stubFetch([telegramOk, resendOk])

    const res = await GET(reqAuthed())
    expect(res.status).toBe(202)
    await runDeferred()

    const log = terminalLog(rpcCalls)
    // The whole point: an unreadable payload must not read as a healthy sweep.
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("unexpected payload shape")
    // It still sends nothing (there is nothing to send) — but it no longer
    // claims that silence was a measurement.
    expect(f.calls.filter((c) => c.url.includes("telegram") || c.url.includes("resend"))).toHaveLength(0)
    expect(writes.alert_notifications_sent ?? []).toHaveLength(0)
  })

  // Positive control for the three cases above, and for the info-only case
  // below. An EMPTY ARRAY is a real measurement of zero active alerts and must
  // stay ok=true — without this, "treat everything as unreadable" would satisfy
  // the shape regressions while breaking the alerting pipeline's normal path.
  it("an EMPTY ARRAY of alerts is an honest zero and still logs ok=true", async () => {
    const { rpcCalls } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      ...NO_FMV_TRIGGERS,
    })
    stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect(log?.p_error ?? null).toBeNull()
  })

  it("only info-severity alerts → no notify, debounced false, ok=true", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": {
        data: [{ type: "slow", detail: "p95 rising", pipeline: "offers-sweep", severity: "info" }],
        error: null,
      },
      ...NO_FMV_TRIGGERS,
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    expect(f.calls.filter((c) => c.url.includes("telegram") || c.url.includes("resend"))).toHaveLength(0)
    expect(writes.alert_notifications_sent ?? []).toHaveLength(0)
    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect((log?.p_extra as { pipeline_alerts?: { alerts_critical_or_high?: number } })?.pipeline_alerts?.alerts_critical_or_high).toBe(0)
  })

  it("one channel failing still notifies + stamps the debounce and records channel_errors", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: HOT_ALERTS, error: null },
      alert_notifications_sent: { data: null, error: null },
      ...NO_FMV_TRIGGERS,
    })
    // Telegram ok, Resend (email) fails — not both, so the debounce still stamps.
    stubFetch([telegramOk, jsonRoute("api.resend.com", { error: "boom" }, { status: 500 })])

    await GET(reqAuthed())
    await runDeferred()

    expect(writes.alert_notifications_sent?.some((w) => w.method === "upsert")).toBe(true)
    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(true)
    const pa = (log?.p_extra as { pipeline_alerts?: { channel_errors?: { email?: string }; telegrams_sent?: number; emails_sent?: number } })?.pipeline_alerts
    expect(pa?.channel_errors?.email).toBeTruthy()
    expect(pa?.telegrams_sent).toBe(1)
    expect(pa?.emails_sent).toBe(0)
  })

  it("truncates the telegram payload past 12 hot alerts and marks the subject", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      type: "cron_silent",
      detail: `d${i}`,
      pipeline: `pipe-${i}`,
      severity: "critical",
    }))
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: many, error: null },
      alert_notifications_sent: { data: null, error: null },
      ...NO_FMV_TRIGGERS,
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    const tgCall = f.calls.find((c) => c.url.includes("api.telegram.org"))
    const tgBody = JSON.parse(String(tgCall!.init?.body))
    expect(tgBody.text).toContain("and 1 more")
    const stamp = writes.alert_notifications_sent?.find((w) => w.method === "upsert")
    expect(stamp?.rows[0]).toMatchObject({ pipeline_count: 13 })
    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(true)
  })
})

describe("GET /api/check-alerts — FMV leg edge branches", () => {
  it("check_triggered_fmv_alerts error logs ok=false and skips the alert loop", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": { data: null, error: { message: "fmv rpc boom" } },
    })
    stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    expect(writes.fmv_alerts ?? []).toHaveLength(0)
    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("check_triggered_fmv_alerts")
  })

  it("a fresh alert with no email target sends nothing but still stamps last_triggered_at", async () => {
    const { rpcCalls, writes } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": {
        data: {
          total_triggered: 1,
          triggered_alerts: [
            { alert_id: "no-email", player_name: "X", alert_type: "below_price", threshold: 5, notification_email: null, channel: "email", last_triggered_at: null },
          ],
        },
        error: null,
      },
      fmv_alerts: { data: null, error: null },
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    expect(f.calls.filter((c) => c.url.includes("api.resend.com"))).toHaveLength(0)
    expect(writes.fmv_alerts?.some((w) => w.method === "update")).toBe(true)
    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 0 })
  })

  it("a failed alert email is recorded as an fmv error → ok=false", async () => {
    const { rpcCalls } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": {
        data: {
          total_triggered: 1,
          triggered_alerts: [
            { alert_id: "send-fail", player_name: "X", alert_type: "below_price", threshold: 5, notification_email: "u@e.com", channel: "email", last_triggered_at: null },
          ],
        },
        error: null,
      },
      fmv_alerts: { data: null, error: null },
    })
    stubFetch([telegramOk, jsonRoute("api.resend.com", { error: "boom" }, { status: 500 })])

    await GET(reqAuthed())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("fmv errs")
  })

  it("a failed last_triggered_at stamp (non-throwing db error) is recorded as an fmv error", async () => {
    const { rpcCalls } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": {
        data: {
          total_triggered: 1,
          triggered_alerts: [
            { alert_id: "stamp-fail", player_name: "X", alert_type: "below_price", threshold: 5, notification_email: null, channel: "email", last_triggered_at: null },
          ],
        },
        error: null,
      },
      fmv_alerts: { data: null, error: { message: "stamp boom" } },
    })
    stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("fmv errs")
  })

  it("renders the email body for above_fmv / below_fmv / unknown types and large + missing prices", async () => {
    const { rpcCalls } = install({
      "rpc:get_pipeline_alerts": { data: [], error: null },
      "rpc:check_triggered_fmv_alerts": {
        data: {
          total_triggered: 3,
          triggered_alerts: [
            { alert_id: "big", player_name: "Big", set_name: "S", alert_type: "above_fmv", threshold: 1200, notification_email: "u@e.com", channel: "email", last_triggered_at: null, lowest_ask: null, current_fmv: 1500 },
            { alert_id: "low", player_name: "Low", alert_type: "below_fmv", threshold: 500, notification_email: "u@e.com", channel: "email", last_triggered_at: null, lowest_ask: null, current_fmv: null },
            { alert_id: "unk", player_name: "Unk", alert_type: "mystery", threshold: 9, notification_email: "u@e.com", channel: "email", last_triggered_at: null, lowest_ask: null, current_fmv: null },
          ],
        },
        error: null,
      },
      fmv_alerts: { data: null, error: null },
    })
    const f = stubFetch([telegramOk, resendOk])

    await GET(reqAuthed())
    await runDeferred()

    const emails = f.calls.filter((c) => c.url.includes("api.resend.com"))
    expect(emails).toHaveLength(3)
    const bodies = emails.map((e) => JSON.parse(String(e.init?.body)))
    const big = bodies.find((b) => b.subject.includes("Big"))
    expect(big.html).toContain("FMV climbed above")
    expect(big.html).toContain("$1,500") // fmtUsd >= 1000 → localeString
    const low = bodies.find((b) => b.subject.includes("Low"))
    expect(low.html).toContain("FMV dropped below")
    const unk = bodies.find((b) => b.subject.includes("Unk"))
    expect(unk.html).toContain("Threshold 9 hit")
    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 3 })
  })
})
