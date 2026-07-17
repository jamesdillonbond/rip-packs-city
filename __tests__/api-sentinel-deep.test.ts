import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Deep test for POST /api/sentinel — drives the full check battery with fixtures
// and pins the two production incident classes:
//   1. Saturation/empty-error inconclusive classification (2026-06-10 + 2026-07-16
//      false-CRITICAL pages): a query error that cannot PROVE data loss must warn,
//      never page critical.
//   2. Silent-alert-failure guard: a dead Telegram/Resend channel must report
//      "-FAILED", never claim delivery.
// Plus the config table contract: thresholds override, disabled checks are
// neutralized but stay visible.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

// Notification env must exist BEFORE the module loads (read into module consts).
process.env.INGEST_SECRET_TOKEN = "sentinel-token"
process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "12345"
process.env.RESEND_API_KEY = "re-key"
process.env.ALERT_EMAIL = "ops@example.com"

const { POST } = await import("@/app/api/sentinel/route")

function post(): NextRequest {
  return new NextRequest("https://t/api/sentinel", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer sentinel-token" }),
  })
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

// A fully-green fixture set; individual tests override single keys.
function greenFixtures(): Fixtures {
  return {
    sentinel_threshold_config: { data: [], error: null },
    sales: { count: 1500, error: null } as unknown as { data?: unknown; error?: unknown },
    fmv_snapshots: { data: [{ computed_at: new Date().toISOString() }], error: null },
    "rpc:sentinel_fmv_confidence_canonical_ts": {
      data: [
        { confidence: "HIGH", count: 100 },
        { confidence: "MEDIUM", count: 300 },
        { confidence: "LOW", count: 600 },
      ],
      error: null,
    },
    // editions is read twice: (1) coverage denominator count, (2) 48h UUID-leak count.
    editions: [
      { count: 1000, error: null } as unknown as { data?: unknown; error?: unknown },
      { count: 3, error: null } as unknown as { data?: unknown; error?: unknown },
    ],
    "rpc:sentinel_fmv_confidence_rows": {
      data: [{ confidence: "HIGH", count: 500 }, { confidence: "LOW", count: 450 }],
      error: null,
    },
    "rpc:detect_stalled_pipelines": { data: [], error: null },
    v_rpc_trust_health: {
      data: [
        { metric: "topshot_fmv_stale_hours", value: 1, breach_at: 6, status: "ok" },
        { metric: "offer_edition_gap", value: 0, breach_at: 50, status: "ok" },
      ],
      error: null,
    },
    "rpc:sentinel_total_sales_estimate": { data: 4200000, error: null },
  }
}

function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const sniperOk = jsonRoute("/api/sniper-feed", {
  deals: [{ source: "topshot" }, { source: "flowty" }],
})
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
  process.env.INGEST_SECRET_TOKEN = "sentinel-token"
})

interface Check {
  name: string
  status: string
  detail: string
}
function check(report: { checks: Check[] }, name: string): Check {
  const c = report.checks.find((x) => x.name === name)
  if (!c) throw new Error(`check not found: ${name}`)
  return c
}

describe("POST /api/sentinel — full battery", () => {
  it("reports ALL CLEAR when every check is green", async () => {
    install(greenFixtures())
    stubFetch([sniperOk, telegramOk, resendOk])

    const res = await POST(post())
    expect(res.status).toBe(200)
    const report = await res.json()

    expect(report.status).toBe("ALL CLEAR")
    expect(report.checks.map((c: Check) => c.status)).not.toContain("critical")
    expect(check(report, "Sales Ingest (2h)").detail).toContain("1500 new sales")
    expect(check(report, "FMV Freshness").status).toBe("ok")
    // 100+300 of 1000 canonical TS editions = 40% high+med >= default 25 -> ok.
    expect(check(report, "FMV Confidence (canonical TS)").status).toBe("ok")
    // 950 of 1000 editions covered = 95% >= 90 -> ok.
    expect(check(report, "Edition Coverage").detail).toContain("950 of 1000")
    expect(check(report, "TS Edition Writer Leak (48h)").status).toBe("ok")
    expect(check(report, "Pipeline Silence").status).toBe("ok")
    expect(check(report, "Trust Health").detail).toBe("2/2 trust metrics ok")
    expect(check(report, "Sniper Feed").detail).toBe("2 deals (TS: 1, Flowty: 1)")
  })

  it("classifies a statement-timeout sales error as inconclusive WARN, not CRITICAL (2026-06-10 class)", async () => {
    const f = greenFixtures()
    f.sales = { data: null, error: { message: "canceling statement due to statement timeout" } } as never
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const sales = check(report, "Sales Ingest (2h)")
    expect(sales.status).toBe("warn")
    expect(sales.detail).toContain("INCONCLUSIVE (db saturated)")
    expect(report.status).toBe("WARN")
  })

  it("classifies an EMPTY error message as inconclusive WARN (2026-07-16 false-CRITICAL class)", async () => {
    const f = greenFixtures()
    f.sales = { data: null, error: { message: "" } } as never
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const sales = check(report, "Sales Ingest (2h)")
    expect(sales.status).toBe("warn")
    expect(report.status).not.toBe("CRITICAL")
  })

  it("a GENUINE zero-sales window still pages CRITICAL and marks a dead Telegram channel as FAILED", async () => {
    const f = greenFixtures()
    f.sales = { count: 0, error: null } as never
    install(f)
    // Telegram is down (500); Resend accepts.
    stubFetch([sniperOk, jsonRoute("api.telegram.org", { ok: false }, { status: 500 }), resendOk])

    const report = await (await POST(post())).json()
    expect(report.status).toBe("CRITICAL")
    expect(check(report, "Sales Ingest (2h)").detail).toContain("ZERO sales")
    // Silent-alert-failure guard: the dead channel must not claim delivery.
    expect(report.notifications).toContain("telegram-FAILED")
    expect(report.notifications).toContain("email")
  })

  it("high-severity stalled pipelines page CRITICAL with the stall detail", async () => {
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: [
        { pipeline: "topshot-sales-indexer", severity: "high", silent_minutes: 120, max_silent_minutes: 45 },
        { pipeline: "wmc-fmv-populate", severity: "medium", silent_minutes: 80, max_silent_minutes: 60 },
      ],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const silence = check(report, "Pipeline Silence")
    expect(silence.status).toBe("critical")
    expect(silence.detail).toContain("topshot-sales-indexer silent 120m")
    expect(report.status).toBe("CRITICAL")
  })

  it("config thresholds override the hardcoded defaults", async () => {
    const f = greenFixtures()
    // Raise the sales critical bar above the observed count: 1500 <= 2000 -> critical.
    f.sentinel_threshold_config = {
      data: [{ check_name: "Sales Ingest (2h)", warn_at: null, crit_at: 2000, enabled: true }],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    expect(check(report, "Sales Ingest (2h)").status).toBe("critical")
  })

  it("a config-disabled check is neutralized to ok but stays visible with the annotation", async () => {
    const f = greenFixtures()
    f.sales = { count: 0, error: null } as never
    f.sentinel_threshold_config = {
      data: [{ check_name: "Sales Ingest (2h)", warn_at: null, crit_at: null, enabled: false }],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const sales = check(report, "Sales Ingest (2h)")
    expect(sales.status).toBe("ok")
    expect(sales.detail).toContain("[check disabled via config]")
    expect(report.status).toBe("ALL CLEAR")
  })

  it("trust-health breaches warn (never page) and name the breaching metric", async () => {
    const f = greenFixtures()
    f.v_rpc_trust_health = {
      data: [
        { metric: "topshot_impossible_parallel_serials", value: 16, breach_at: 3, status: "breach" },
        { metric: "offer_edition_gap", value: 0, breach_at: 50, status: "ok" },
      ],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const trust = check(report, "Trust Health")
    expect(trust.status).toBe("warn")
    expect(trust.detail).toContain("topshot_impossible_parallel_serials=16")
    expect(report.status).toBe("WARN")
  })

  it("a sniper-feed self-fetch timeout is inconclusive (warn), a non-OK response is critical", async () => {
    install(greenFixtures())
    stubFetch([jsonRoute("/api/sniper-feed", { error: "gateway" }, { status: 504 }), telegramOk, resendOk])
    let report = await (await POST(post())).json()
    expect(check(report, "Sniper Feed").status).toBe("critical")

    install(greenFixtures())
    stubFetch([
      {
        match: (url) => url.includes("/api/sniper-feed"),
        respond: () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
        },
      },
      telegramOk,
      resendOk,
    ])
    report = await (await POST(post())).json()
    const sniper = check(report, "Sniper Feed")
    expect(sniper.status).toBe("warn")
    expect(sniper.detail).toContain("INCONCLUSIVE")
  })
})
