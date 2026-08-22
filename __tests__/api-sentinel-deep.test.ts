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
    // Split by printing class: base HIGH+MED = 400/1000 = 40% >= 25 -> ok.
    "rpc:sentinel_fmv_confidence_canonical_ts_split": {
      data: [
        { printing: "base", confidence: "HIGH", count: 100 },
        { printing: "base", confidence: "MEDIUM", count: 300 },
        { printing: "base", confidence: "LOW", count: 600 },
        { printing: "parallel", confidence: "HIGH", count: 10 },
        { printing: "parallel", confidence: "MEDIUM", count: 20 },
        { printing: "parallel", confidence: "LOW", count: 470 },
      ],
      error: null,
    },
    // editions is read once now: the 48h UUID-leak count. Coverage moved to
    // sentinel_edition_coverage() and no longer reads count(*) FROM editions.
    editions: { count: 3, error: null } as unknown as { data?: unknown; error?: unknown },
    // 950 of 1000 live editions covered = 95% >= 90 -> ok; inert bucket reported separately.
    "rpc:sentinel_edition_coverage": {
      data: [
        { scope: "live", editions: 1000, with_fmv: 950 },
        { scope: "inert_ts_uuid", editions: 128, with_fmv: 100 },
      ],
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
    // Ownership Index Freshness reads the most recent productive run of either
    // ownership writer. Fresh => ok.
    pipeline_runs: {
      data: [{ pipeline: "ownership-onchain-walk", started_at: new Date().toISOString() }],
      error: null,
    },
    // Per-collection + per-source ingest health — all within their ceilings.
    "rpc:sentinel_sales_ingest_health": { data: ingestHealthy(), error: null },
    // Pipeline Success Coverage: two watchlisted pipelines, both with at least one
    // success in the window. NOTE the arm reports INCONCLUSIVE (warn) on an EMPTY
    // watchlist by design — "we measured nothing" is not "everything is fine" — so
    // a green battery has to model the watchlist, not omit it.
    pipeline_cadence_watchlist: {
      data: [{ pipeline: "topshot-sales-indexer" }, { pipeline: "fmv-recalc" }],
      error: null,
    },
    pipeline_alert_suppression: { data: [], error: null },
    pipeline_runs_daily: {
      data: [
        { pipeline: "topshot-sales-indexer", runs: 70, ok_count: 68, rows_written: 4200, last_error: null, refreshed_at: new Date().toISOString() },
        { pipeline: "fmv-recalc", runs: 40, ok_count: 25, rows_written: 19000, last_error: null, refreshed_at: new Date().toISOString() },
      ],
      error: null,
    },
  }
}

// Mirrors sentinel_sales_ingest_health() output: one row per (collection,
// source), each carrying the collection's hours-since-last + its config.
function ingestHealthy(): Record<string, unknown>[] {
  return [
    { collection: "nba_top_shot", display_name: "Top Shot", marketplace: "topshot", source: "onchain", sales_1h: 50, sales_6h: 800, sales_24h: 2000, coll_hours_since_last: 0.3, silence_hours: 3, loudness: "critical" },
    { collection: "nba_top_shot", display_name: "Top Shot", marketplace: "topshot", source: "offer_fill", sales_1h: 6, sales_6h: 116, sales_24h: 550, coll_hours_since_last: 0.3, silence_hours: 3, loudness: "critical" },
    { collection: "nfl_all_day", display_name: "All Day", marketplace: "nflallday", source: "onchain_dapper_v2", sales_1h: 9, sales_6h: 11, sales_24h: 71, coll_hours_since_last: 0.4, silence_hours: 12, loudness: "critical" },
    { collection: "candy_mlb", display_name: "Candy MLB", marketplace: "magic_eden", source: "solana_das", sales_1h: 0, sales_6h: 25, sales_24h: 183, coll_hours_since_last: 2.3, silence_hours: 12, loudness: "warn" },
    { collection: "disney_pinnacle", display_name: "Pinnacle", marketplace: "pinnacle", source: "on-chain", sales_1h: 0, sales_6h: 28, sales_24h: 116, coll_hours_since_last: 1.5, silence_hours: 12, loudness: "warn" },
    { collection: "laliga_golazos", display_name: "Golazos", marketplace: "(none)", source: "(none)", sales_1h: 0, sales_6h: 0, sales_24h: 0, coll_hours_since_last: 68, silence_hours: 168, loudness: "warn" },
    { collection: "ufc_strike", display_name: "UFC", marketplace: "(none)", source: "(none)", sales_1h: 0, sales_6h: 0, sales_24h: 0, coll_hours_since_last: 2088, silence_hours: 999, loudness: "off" },
  ]
}

function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

/**
 * install() plus a record of the FILTERS applied per table.
 *
 * The shared fixture's chainables discard their arguments, which is fine for
 * almost every check — but the Sales Ingest (2h) fix IS a filter. `sales` has no
 * index on `ingested_at`, so that predicate alone parallel-seq-scans all 8
 * partitions; bounding `sold_at` (the partition key) is what lets the planner
 * prune 6 of them. A test that only asserts the resulting status would pass just
 * as happily with the bound deleted, i.e. it would assert nothing about the one
 * thing this change is.
 */
function installRecordingFilters(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  const f = spy.fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = f.from.bind(f)
  // `in` is recorded WITH its value list: the Ownership Index Freshness arm must
  // span BOTH ownership writers, and since the fixture's chainables discard their
  // arguments, dropping one writer is otherwise invisible to any status assertion.
  const filters: Record<string, Array<{ op: string; col: string; val?: unknown }>> = {}
  const queryCount: Record<string, number> = {}
  f.from = (table: string) => {
    queryCount[table] = (queryCount[table] ?? 0) + 1
    const b = baseFrom(table)
    for (const op of ["gte", "lte", "gt", "lt", "eq", "in"] as const) {
      const base = b[op] as (...a: unknown[]) => unknown
      b[op] = (...args: unknown[]) => {
        ;(filters[table] ??= []).push({ op, col: String(args[0]), val: args[1] })
        return base(...args)
      }
    }
    return b
  }
  state.sb = f
  return { ...spy, filters, queryCount }
}

const sniperOk = jsonRoute("/api/sniper-feed", {
  deals: [{ source: "topshot" }, { source: "allday" }],
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
    // base 100+300 of 1000 canonical TS base editions = 40% high+med >= default 25 -> ok.
    expect(check(report, "FMV Confidence (canonical TS)").status).toBe("ok")
    expect(check(report, "FMV Confidence (canonical TS)").detail).toContain("BASE HIGH+MED: 40.0%")
    // 950 of 1000 live editions covered = 95% >= 90 -> ok; inert bucket excluded.
    expect(check(report, "Edition Coverage").detail).toContain("950 of 1000 live editions")
    expect(check(report, "Edition Coverage").detail).toContain("excludes 128 inert")
    expect(check(report, "TS Edition Writer Leak (48h)").status).toBe("ok")
    expect(check(report, "Pipeline Silence").status).toBe("ok")
    expect(check(report, "Trust Health").detail).toBe("2/2 trust metrics ok")
    expect(check(report, "Sniper Feed").detail).toBe("2 deals (topshot: 1, allday: 1)")
    expect(check(report, "Ownership Index Freshness").status).toBe("ok")
  })

  // Ownership Index Freshness — the arm added after ownership-onchain-walk failed
  // two daily ticks (2026-08-15/16) with every cadence-shaped instrument reading
  // healthy, because the cron fired on time and a FAILING run still logs a row.
  describe("Ownership Index Freshness", () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

    it("goes critical when the last productive write is older than the crit threshold", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: {
          data: [{ pipeline: "ownership-onchain-walk", started_at: hoursAgo(80) }],
          error: null,
        },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const report = await (await POST(post())).json()
      const c = check(report, "Ownership Index Freshness")
      expect(c.status).toBe("critical")
      expect(c.detail).toContain("80.0h ago")
    })

    it("warns after one missed daily tick without paging", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: {
          data: [{ pipeline: "ownership-onchain-walk", started_at: hoursAgo(40) }],
          error: null,
        },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const report = await (await POST(post())).json()
      expect(check(report, "Ownership Index Freshness").status).toBe("warn")
    })

    // The arm must span BOTH writers: the Dune replay is WEEKLY, so a quiet walk
    // is not an outage if Dune just refreshed the index. Reading only the walk
    // would page during a legitimately healthy week.
    it("stays ok when the weekly Dune writer is the freshest source", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: {
          data: [{ pipeline: "ownership-sync-dune", started_at: hoursAgo(2) }],
          error: null,
        },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const c = check(await (await POST(post())).json(), "Ownership Index Freshness")
      expect(c.status).toBe("ok")
      expect(c.detail).toContain("ownership-sync-dune")
    })

    // THE load-bearing case. pipeline_runs prunes at ~73h, so once the outage
    // outlives retention the query returns NOTHING — and "no rows" is the state
    // the arm must never read as healthy, because it arrives exactly when the
    // outage has gone on long enough to matter.
    it("treats an empty pipeline_runs window as CRITICAL, not ok, and dates it from the indefinite rollup", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: { data: [], error: null },
        pipeline_runs_daily: { data: [{ day: "2026-08-01" }], error: null },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const c = check(await (await POST(post())).json(), "Ownership Index Freshness")
      expect(c.status).toBe("critical")
      expect(c.detail).toContain("2026-08-01")
      expect(c.detail).toContain("no fresh write")
    })

    // Same empty window, but the rollup is unreadable too: still critical, and the
    // detail must state a bound it can substantiate rather than inventing an age.
    it("stays critical with honest wording when the rollup cannot date it either", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: { data: [], error: null },
        pipeline_runs_daily: { data: [], error: null },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const c = check(await (await POST(post())).json(), "Ownership Index Freshness")
      expect(c.status).toBe("critical")
      expect(c.detail).toContain("retention")
      expect(c.detail).not.toMatch(/\d+(\.\d+)?h ago/)
    })

    // The two-writer property, asserted at the QUERY rather than via status. The
    // fixture's chainables discard their arguments, so a status-only test passes
    // just as happily with a writer deleted from the list — it would assert
    // nothing about the one thing that keeps this arm from paging during a
    // healthy Dune-only week. Also pins rows_written > 0, which is what makes
    // this an OUTCOME check rather than a cadence one: a failing run still logs.
    it("queries BOTH ownership writers and requires rows_written > 0", async () => {
      const spy = installRecordingFilters(greenFixtures())
      stubFetch([sniperOk, telegramOk, resendOk])
      await POST(post())

      const runFilters = spy.filters.pipeline_runs ?? []
      const writers = runFilters.find((f) => f.op === "in" && f.col === "pipeline")
      expect(writers?.val).toEqual(
        expect.arrayContaining(["ownership-onchain-walk", "ownership-sync-dune"])
      )
      expect(runFilters).toContainEqual(
        expect.objectContaining({ op: "gt", col: "rows_written", val: 0 })
      )
    })

    // A saturated DB is not data loss — the platform-wide rule for this route.
    it("warns rather than pages when the query itself fails under saturation", async () => {
      install({
        ...greenFixtures(),
        pipeline_runs: { data: null, error: { message: "canceling statement due to statement timeout" } },
      })
      stubFetch([sniperOk, telegramOk, resendOk])
      const c = check(await (await POST(post())).json(), "Ownership Index Freshness")
      expect(c.status).toBe("warn")
    })
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

  // ── Sales Ingest (2h): partition pruning + the forward/total distinction ──
  //
  // Context: measured 2026-08-13, this check was the largest low-hit-ratio
  // reader on the instance (~2.2 GB/call, 11.7% hit, 28.3 GB over 39.7 h),
  // because `sales.ingested_at` has no index and the predicate alone scans all
  // 8 partitions. It is NOT redundant with the per-collection arm — that keys on
  // `sold_at` (market time), this on `ingested_at` (did we write anything) — so
  // the fix had to make it cheaper WITHOUT deleting it.

  it("bounds the partition key so the common path cannot scan every partition", async () => {
    const f = greenFixtures()
    f.sales = { count: 1500, error: null } as never
    const spy = installRecordingFilters(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    expect(check(report, "Sales Ingest (2h)").status).toBe("ok")

    const cols = (spy.filters.sales ?? []).map((x) => x.col)
    // ingested_at is the QUESTION; sold_at is what makes it affordable. Both.
    expect(cols).toContain("ingested_at")
    expect(cols, "sold_at bound missing — the planner would scan all 8 partitions").toContain("sold_at")
    // And the expensive unbounded probe must NOT run on the healthy path.
    expect(spy.queryCount.sales).toBe(1)
  })

  it("does not pay for the unbounded scan when the count is merely below a floor", async () => {
    // Below a configured floor is a THRESHOLD breach, not an outage — there is
    // nothing for the second probe to disambiguate, so it must not run.
    const f = greenFixtures()
    f.sentinel_threshold_config = {
      data: [{ check_name: "Sales Ingest (2h)", warn_at: null, crit_at: 2000, enabled: true }],
      error: null,
    }
    f.sales = { count: 1500, error: null } as never
    const spy = installRecordingFilters(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const sales = check(await (await POST(post())).json(), "Sales Ingest (2h)")
    expect(sales.status).toBe("critical")
    // Must NOT claim zero — 1500 rows did land.
    expect(sales.detail).not.toContain("ZERO")
    expect(sales.detail).toContain("below the configured floor of 2000")
    expect(spy.queryCount.sales).toBe(1)
  })

  it("names the failure when forward ingest is dead but backfills are still landing", async () => {
    // The distinction the old check could not make at all: a lone history
    // backfill ticking away used to SATISFY it while every forward indexer was
    // dead. Now zero-forward triggers the second probe, and 250 historical rows
    // mean the writer is alive and the forward lane specifically is down.
    const f = greenFixtures()
    f.sales = [{ count: 0, error: null }, { count: 250, error: null }] as never
    const spy = installRecordingFilters(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const sales = check(await (await POST(post())).json(), "Sales Ingest (2h)")
    expect(sales.status).toBe("critical")
    expect(sales.detail).toContain("forward indexers appear DOWN")
    expect(sales.detail).toContain("250 historical")
    expect(spy.queryCount.sales).toBe(2)
  })

  it("keeps the plain total-outage wording when nothing at all was ingested", async () => {
    const f = greenFixtures()
    f.sales = [{ count: 0, error: null }, { count: 0, error: null }] as never
    installRecordingFilters(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const sales = check(await (await POST(post())).json(), "Sales Ingest (2h)")
    expect(sales.status).toBe("critical")
    expect(sales.detail).toContain("ZERO sales ingested in last 2 hours")
    expect(sales.detail).not.toContain("historical")
  })

  it("still pages, and says the probe was inconclusive, when the second scan errors", async () => {
    // The second probe is the expensive one, so it is the one most likely to be
    // killed by the saturation it is trying to describe. It must degrade the
    // DETAIL, never downgrade a genuine zero-forward-ingest page.
    const f = greenFixtures()
    f.sales = [
      { count: 0, error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
    ] as never
    installRecordingFilters(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const sales = check(await (await POST(post())).json(), "Sales Ingest (2h)")
    expect(sales.status).toBe("critical")
    expect(sales.detail).toContain("ZERO forward sales")
    expect(sales.detail).toContain("db saturated")
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

  // ⚠ A NULL `silent_minutes` is the arm's MOST SEVERE reading — detect_stalled_pipelines()
  // found no run at all in `pipeline_runs` (~73h retention) — and it used to render as the
  // literal "silent nullm". That reads as a cosmetic template bug, so the worst case was
  // the least legible thing in the alert. Measured 2026-08-22: `candy-editions-ingest` had
  // missed three consecutive daily ticks on a collection public since 07-31, and the alert
  // said `silent nullm`.
  it("a NULL silent_minutes renders as a stated fact, never as the string 'nullm'", async () => {
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: [
        { pipeline: "candy-editions-ingest", severity: "medium", silent_minutes: null, max_silent_minutes: 1800, last_run: null },
      ],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const silence = check(report, "Pipeline Silence")
    // Assert the ABSENCE of the false/garbled claim, not merely the presence of some text.
    expect(silence.detail).not.toContain("nullm")
    expect(silence.detail).not.toContain("null")
    expect(silence.detail).toContain("candy-editions-ingest")
    expect(silence.status).toBe("warn")
  })

  it("does NOT invent a silence figure when silent_minutes is NULL", async () => {
    // ⚠ THIS IS A FORWARD PIN, NOT A REGRESSION TEST — stated because a reader would
    // otherwise assume it caught the nullm bug. It passes on the ORIGINAL buggy code too
    // (the string "nullm" happens to contain no digit), so it discriminates nothing about
    // that defect. What it does catch is the tempting WRONG FIX: substituting a computed
    // figure for the null. The arm cannot distinguish "stalled past the retention window"
    // from "never ran once", so any number here would be fabricated — the shape this repo
    // tracks. The test above is the one that reds on the original bug.
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: [
        { pipeline: "candy-editions-ingest", severity: "medium", silent_minutes: null, max_silent_minutes: 1800, last_run: null },
      ],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    const detail = check(report, "Pipeline Silence").detail as string
    // The only number in the line must be the threshold itself (1800), never a silence figure.
    const silenceClause = detail.slice(0, detail.indexOf("(>"))
    expect(silenceClause).not.toMatch(/\d/)
    expect(detail).toContain("1800m")
  })

  it("still renders a real silent_minutes unchanged — the null branch must not swallow the normal case", async () => {
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: [
        { pipeline: "pinnacle-sync", severity: "medium", silent_minutes: 3191, max_silent_minutes: 1560 },
      ],
      error: null,
    }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])

    const report = await (await POST(post())).json()
    expect(check(report, "Pipeline Silence").detail).toContain("pinnacle-sync silent 3191m")
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

  it("per-collection ingest health is green and names every collection + source lane", async () => {
    install(greenFixtures())
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()

    const byColl = check(report, "Sales Ingest by Collection")
    expect(byColl.status).toBe("ok")
    // every watched collection is present, including the closed one
    for (const name of ["Top Shot", "All Day", "Candy MLB", "Pinnacle", "Golazos", "UFC"]) {
      expect(byColl.detail).toContain(name)
    }
    expect(byColl.detail).toContain("market closed") // UFC labelled, never alarmed
    // Top Shot rolls up both sources: 2000 + 550 = 2550
    expect(byColl.detail).toContain("Top Shot 2550/24h")

    const bySrc = check(report, "Sales Ingest by Source")
    expect(bySrc.status).toBe("ok")
    expect(bySrc.detail).toContain("Top Shot/onchain: 2000")
    expect(bySrc.detail).toContain("Top Shot/offer_fill: 550")
    expect(bySrc.detail).toContain("Pinnacle/on-chain: 116") // separate pinnacle_sales table folded in
    expect(report.status).toBe("ALL CLEAR")
  })

  it("a page-loud collection (Top Shot) silent past its ceiling pages CRITICAL", async () => {
    const f = greenFixtures()
    const rows = ingestHealthy().map((r) =>
      r.collection === "nba_top_shot" ? { ...r, sales_1h: 0, sales_6h: 0, sales_24h: 0, coll_hours_since_last: 5 } : r
    )
    f["rpc:sentinel_sales_ingest_health"] = { data: rows, error: null }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()

    const byColl = check(report, "Sales Ingest by Collection")
    expect(byColl.status).toBe("critical") // 5h > 3h ceiling, loudness critical
    expect(byColl.detail).toContain(">3h!")
    expect(report.status).toBe("CRITICAL")
  })

  it("a non-loud collection (Candy) silent past its ceiling only WARNs", async () => {
    const f = greenFixtures()
    const rows = ingestHealthy().map((r) =>
      r.collection === "candy_mlb" ? { ...r, sales_6h: 0, sales_24h: 0, coll_hours_since_last: 20 } : r
    )
    f["rpc:sentinel_sales_ingest_health"] = { data: rows, error: null }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()

    const byColl = check(report, "Sales Ingest by Collection")
    expect(byColl.status).toBe("warn") // 20h > 12h ceiling, loudness warn
    expect(report.status).toBe("WARN")
  })

  it("a single dead lane while its collection still flows WARNs (by source)", async () => {
    const f = greenFixtures()
    // TS offer_fill dies (0/24h) but onchain still flows -> collection rollup ok,
    // lane view must catch it.
    const rows = ingestHealthy().map((r) =>
      r.collection === "nba_top_shot" && r.source === "offer_fill"
        ? { ...r, sales_1h: 0, sales_6h: 0, sales_24h: 0 }
        : r
    )
    f["rpc:sentinel_sales_ingest_health"] = { data: rows, error: null }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()

    expect(check(report, "Sales Ingest by Collection").status).toBe("ok") // onchain still fresh
    const bySrc = check(report, "Sales Ingest by Source")
    expect(bySrc.status).toBe("warn")
    expect(bySrc.detail).toContain("LANE SILENT")
    expect(bySrc.detail).toContain("Top Shot/offer_fill")
  })

  it("a saturation error on the ingest RPC is inconclusive (warn), a real error pages", async () => {
    // Saturation -> both new checks warn, never page.
    let f = greenFixtures()
    f["rpc:sentinel_sales_ingest_health"] = { data: null, error: { message: "canceling statement due to statement timeout" } }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    let report = await (await POST(post())).json()
    expect(check(report, "Sales Ingest by Collection").status).toBe("warn")
    expect(check(report, "Sales Ingest by Collection").detail).toContain("INCONCLUSIVE")
    expect(check(report, "Sales Ingest by Source").status).toBe("warn")

    // A non-saturation RPC error is a real failure -> collection check pages.
    f = greenFixtures()
    f["rpc:sentinel_sales_ingest_health"] = { data: null, error: { message: "function does not exist" } }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    report = await (await POST(post())).json()
    expect(check(report, "Sales Ingest by Collection").status).toBe("critical")
  })

  it("a collection that has never traded shows 'never' and does not alarm", async () => {
    const f = greenFixtures()
    const rows = ingestHealthy().map((r) =>
      r.collection === "laliga_golazos" ? { ...r, coll_hours_since_last: null } : r
    )
    f["rpc:sentinel_sales_ingest_health"] = { data: rows, error: null }
    install(f)
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()
    const byColl = check(report, "Sales Ingest by Collection")
    expect(byColl.detail).toContain("Golazos 0/24h (last never)")
    expect(byColl.status).toBe("ok")
  })

  it("UFC (loudness off) never alarms even when silent for months", async () => {
    install(greenFixtures()) // UFC row already has coll_hours_since_last 2088
    stubFetch([sniperOk, telegramOk, resendOk])
    const report = await (await POST(post())).json()
    // UFC contributes nothing to status; overall stays ALL CLEAR
    expect(check(report, "Sales Ingest by Collection").status).toBe("ok")
    expect(report.status).toBe("ALL CLEAR")
  })
})
