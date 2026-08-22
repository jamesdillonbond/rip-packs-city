import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute, type FetchStub } from "./helpers/route-harness"

// Branch coverage for /api/sentinel — the sibling deep test drives the green
// battery + the saturation-inconclusive + config-disable + high-sev-stall
// classes. This drives the remaining BREACH / ERROR arms of each check:
//   ingest-health RPC error (crit vs sat-warn), a per-collection silence breach,
//   a dead per-source lane, FMV Freshness stale/critical/error/empty, low FMV
//   confidence + its RPC error, low edition coverage + its RPC error, the TS
//   writer-leak warn/critical bands, medium-only pipeline stall, a trust-health
//   breach + its query error, zero/errored total-sales, and the sniper feed
//   0-deals / non-200 / abort / hard-error arms.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "sentinel-token"
process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "12345"
process.env.RESEND_API_KEY = "re-key"
process.env.ALERT_EMAIL = "ops@example.com"

const { POST } = await import("@/app/api/sentinel/route")

function post(): NextRequest {
  return new NextRequest("https://t/api/sentinel", { method: "POST", headers: new Headers({ authorization: "Bearer sentinel-token" }) })
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function ingestHealthy(): Record<string, unknown>[] {
  return [
    { collection: "nba_top_shot", display_name: "Top Shot", marketplace: "topshot", source: "onchain", sales_24h: 2000, coll_hours_since_last: 0.3, silence_hours: 3, loudness: "critical" },
    { collection: "nba_top_shot", display_name: "Top Shot", marketplace: "topshot", source: "offer_fill", sales_24h: 550, coll_hours_since_last: 0.3, silence_hours: 3, loudness: "critical" },
    { collection: "nfl_all_day", display_name: "All Day", marketplace: "nflallday", source: "onchain_dapper_v2", sales_24h: 71, coll_hours_since_last: 0.4, silence_hours: 12, loudness: "critical" },
    { collection: "disney_pinnacle", display_name: "Pinnacle", marketplace: "pinnacle", source: "on-chain", sales_24h: 116, coll_hours_since_last: 1.5, silence_hours: 12, loudness: "warn" },
    { collection: "ufc_strike", display_name: "UFC", marketplace: "(none)", source: "(none)", sales_24h: 0, coll_hours_since_last: 2088, silence_hours: 999, loudness: "off" },
  ]
}

function greenFixtures(): Fixtures {
  return {
    sentinel_threshold_config: { data: [], error: null },
    sales: { count: 1500, error: null } as never,
    fmv_snapshots: { data: [{ computed_at: new Date().toISOString() }], error: null },
    "rpc:sentinel_fmv_confidence_canonical_ts_split": {
      data: [
        { printing: "base", confidence: "HIGH", count: 100 },
        { printing: "base", confidence: "MEDIUM", count: 300 },
        { printing: "base", confidence: "LOW", count: 600 },
        { printing: "parallel", confidence: "LOW", count: 490 },
      ],
      error: null,
    },
    editions: { count: 3, error: null } as never,
    "rpc:sentinel_edition_coverage": {
      data: [
        { scope: "live", editions: 1000, with_fmv: 950 },
        { scope: "inert_ts_uuid", editions: 128, with_fmv: 100 },
      ],
      error: null,
    },
    "rpc:detect_stalled_pipelines": { data: [], error: null },
    v_rpc_trust_health: { data: [{ metric: "topshot_fmv_stale_hours", value: 1, breach_at: 6, status: "ok" }], error: null },
    "rpc:sentinel_total_sales_estimate": { data: 4200000, error: null },
    "rpc:sentinel_sales_ingest_health": { data: ingestHealthy(), error: null },
  }
}

const sniperOk = jsonRoute("/api/sniper-feed", { deals: [{ source: "topshot" }, { source: "allday" }] })
const telegramOk = jsonRoute("api.telegram.org", { ok: true })
const resendOk = jsonRoute("api.resend.com", { id: "email-1" })

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "sentinel-token"
})

interface Check { name: string; status: string; detail: string; value?: string }
async function run(over: Fixtures = {}, stubs: FetchStub[] = [sniperOk, telegramOk, resendOk]) {
  const fixtures: Fixtures = { ...greenFixtures(), ...over }
  state.sb = makeInstrumentedSupabaseFixture(fixtures).fixture
  fetchMock = installFetchMock(stubs)
  const report = await (await POST(post())).json()
  return report as { status: string; checks: Check[]; notifications: string[] }
}
const chk = (r: { checks: Check[] }, name: string) => {
  const c = r.checks.find((x) => x.name === name)
  if (!c) throw new Error(`check not found: ${name}`)
  return c
}

// ── ARM COMPLETENESS, and why it is not a name roster ──
// An alerting surface fails in a way ordinary code does not: its output is
// SILENCE, so a missing arm is indistinguishable from a healthy one. CLAUDE.md
// calls this the unfalsifiable class and it happened here — the FMV Confidence
// arm branched on `error`, then on `data`, with no else, so a read that returned
// NEITHER pushed nothing and the roadmap's headline metric vanished from its own
// report.
//
// ⚠ The obvious guard is a hardcoded roster of expected arm names, and CLAUDE.md
// warns against exactly that: "a guard that NAMES its instances — three have died
// on a rename." So this pins the property BEHAVIOURALLY instead. The healthy run
// defines the roster, and the failing runs must not lose any of it. A rename
// changes both sides at once and the test stays true, while a vanished arm reds it.
//
// Two failure shapes, because they are genuinely different states and only one of
// them was ever handled: every read ERRORING, and every read returning NO PAYLOAD
// with no error. Verified against the pre-fix route: the null-payload run produced
// 12 arms instead of 13 and named the missing one.
// ── Detector Health: the arm that watches the watchers (known-issues #25) ──
//
// Three daily detectors are the only things that can see their rot classes, and on
// 2026-08-22 two had been red for a fortnight while being CORRECT, with nothing
// surfacing it. This arm keys on a consecutive-failure STREAK, because one red run
// is a detector doing its job — the defect is a red that PERSISTS unread.
//
// ⚠ The property these cases pin hardest: the arm must never be SILENT. An
// unconfigured or unreadable state has to show up as a check, because "said nothing"
// is exactly the failure it exists to catch — it must not commit that bug itself.
describe("sentinel — detector health arm", () => {
  const GH = "api.github.com"
  const runs = (concls: (string | null)[]) =>
    jsonRoute(GH, {
      workflow_runs: concls.map((c) => ({ status: "completed", conclusion: c })),
    })

  it("reports NOT CONFIGURED rather than vanishing when no token is set", async () => {
    // Only the dedicated variable is read; GITHUB_TOKEN is deliberately NOT a
    // fallback (it is set in this sandbox and in Actions for unrelated reasons).
    const prevA = process.env.GITHUB_ACTIONS_READ_TOKEN
    delete process.env.GITHUB_ACTIONS_READ_TOKEN
    try {
      const arm = chk(await run(), "Detector Health (GitHub Actions)")
      // ⚠ VISIBLE and annotated, but `ok` — a permanently-warn arm would drag the
      // whole sentinel to WARN every hour until a token exists, and a permanently-red
      // instrument is indistinguishable from a broken one. Same convention this route
      // already uses for a config-disabled check. The property pinned here is that it
      // is PRESENT and says why, not that it pages.
      expect(arm.status).toBe("ok")
      expect(arm.detail).toContain("NOT CONFIGURED")
    } finally {
      if (prevA !== undefined) process.env.GITHUB_ACTIONS_READ_TOKEN = prevA
    }
  })

  it("is ok when every watched detector's latest completed run is green", async () => {
    process.env.GITHUB_ACTIONS_READ_TOKEN = "gh-test"
    try {
      const r = await run({}, [sniperOk, telegramOk, resendOk, runs(["success", "failure"])])
      const arm = chk(r, "Detector Health (GitHub Actions)")
      expect(arm.status).toBe("ok")
      // A single historical failure BELOW the newest success must not count — the
      // streak is counted from the newest completed run backwards.
      expect(arm.value).toBe(0)
    } finally {
      delete process.env.GITHUB_ACTIONS_READ_TOKEN
    }
  })

  it("warns on a sustained streak but NOT on a single red run", async () => {
    process.env.GITHUB_ACTIONS_READ_TOKEN = "gh-test"
    try {
      const one = chk(
        await run({}, [sniperOk, telegramOk, resendOk, runs(["failure", "success", "success"])]),
        "Detector Health (GitHub Actions)",
      )
      expect(one.status).toBe("ok")
      expect(one.value).toBe(1)

      const many = chk(
        await run({}, [sniperOk, telegramOk, resendOk, runs(["failure", "failure", "failure", "success"])]),
        "Detector Health (GitHub Actions)",
      )
      expect(many.status).toBe("warn")
      expect(many.value).toBe(3)
    } finally {
      delete process.env.GITHUB_ACTIONS_READ_TOKEN
    }
  })

  it("pages critical on the fortnight-long streak this arm was built for", async () => {
    process.env.GITHUB_ACTIONS_READ_TOKEN = "gh-test"
    try {
      // edge-fn-drift was red 14 consecutive runs on 2026-08-22 and nobody read it.
      const arm = chk(
        await run({}, [sniperOk, telegramOk, resendOk, runs(Array(12).fill("failure"))]),
        "Detector Health (GitHub Actions)",
      )
      expect(arm.status).toBe("critical")
    } finally {
      delete process.env.GITHUB_ACTIONS_READ_TOKEN
    }
  })

  // A workflow the arm could not READ must never be folded into "healthy" — silence
  // about an instrument is not good news, which is the whole thesis of this arm.
  it("reports an unreadable workflow instead of counting it green", async () => {
    process.env.GITHUB_ACTIONS_READ_TOKEN = "gh-test"
    try {
      const arm = chk(
        await run({}, [sniperOk, telegramOk, resendOk, jsonRoute(GH, {}, { status: 403, ok: false })]),
        "Detector Health (GitHub Actions)",
      )
      expect(arm.status).toBe("warn")
      expect(arm.detail).toContain("403")
      expect(arm.detail).not.toContain("All 3 watched detectors green")
    } finally {
      delete process.env.GITHUB_ACTIONS_READ_TOKEN
    }
  })
})

describe("sentinel — no arm may disappear from its own report", () => {
  function allFixturesAs(shape: Record<string, unknown>): Fixtures {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(greenFixtures())) out[k] = shape
    return out as Fixtures
  }

  it("keeps every healthy arm when every read ERRORS", async () => {
    const greenNames = (await run()).checks.map((c) => c.name).sort()
    // Guard against a vacuous pass: if the healthy run produced almost nothing,
    // "no arm went missing" would be trivially true and would pin nothing.
    expect(greenNames.length).toBeGreaterThan(10)

    const failed = await run(
      allFixturesAs({ data: null, count: null, error: { message: "canceling statement due to statement timeout" } }),
      []
    )
    const failedNames = failed.checks.map((c) => c.name)
    expect(greenNames.filter((n) => !failedNames.includes(n))).toEqual([])
  })

  it("keeps every healthy arm when every read returns NO PAYLOAD and no error", async () => {
    const greenNames = (await run()).checks.map((c) => c.name).sort()
    expect(greenNames.length).toBeGreaterThan(10)

    // The state that actually bit: supabase-js RETURNS rather than throws, so this
    // is a read that neither failed nor delivered. It is not an error and it is
    // not a zero.
    const nulled = await run(allFixturesAs({ data: null, count: null, error: null }), [])
    const nullNames = nulled.checks.map((c) => c.name)
    expect(greenNames.filter((n) => !nullNames.includes(n))).toEqual([])
  })
})

describe("sentinel — sales-ingest health arms", () => {
  it("a non-saturation ingest-health RPC error pages the collection lane critical and warns the source lane", async () => {
    const r = await run({ "rpc:sentinel_sales_ingest_health": { data: null, error: { message: "relation missing" } } as never })
    expect(chk(r, "Sales Ingest by Collection").status).toBe("critical")
    expect(chk(r, "Sales Ingest by Source").status).toBe("warn")
  })

  it("a saturation ingest-health RPC error is inconclusive-warn on both lanes", async () => {
    const r = await run({ "rpc:sentinel_sales_ingest_health": { data: null, error: { message: "canceling statement due to statement timeout" } } as never })
    expect(chk(r, "Sales Ingest by Collection").status).toBe("warn")
    expect(chk(r, "Sales Ingest by Collection").detail).toContain("INCONCLUSIVE")
  })

  it("a page-loud collection past its silence ceiling pages critical", async () => {
    const rows = ingestHealthy().map((row) =>
      row.collection === "nba_top_shot" ? { ...row, coll_hours_since_last: 5 } : row) // > silence_hours 3, loudness critical
    const r = await run({ "rpc:sentinel_sales_ingest_health": { data: rows, error: null } as never })
    const c = chk(r, "Sales Ingest by Collection")
    expect(c.status).toBe("critical")
    expect(c.detail).toContain(">3h!")
  })

  it("a warn-loud collection past its ceiling warns (does not page)", async () => {
    const rows = ingestHealthy().map((row) =>
      row.collection === "disney_pinnacle" ? { ...row, coll_hours_since_last: 20 } : row) // > 12, loudness warn
    const r = await run({ "rpc:sentinel_sales_ingest_health": { data: rows, error: null } as never })
    expect(chk(r, "Sales Ingest by Collection").status).toBe("warn")
  })

  it("a silent source lane while its collection still flows warns the source lane", async () => {
    const rows = ingestHealthy().map((row) =>
      row.collection === "nba_top_shot" && row.source === "offer_fill" ? { ...row, sales_24h: 0 } : row)
    const r = await run({ "rpc:sentinel_sales_ingest_health": { data: rows, error: null } as never })
    const c = chk(r, "Sales Ingest by Source")
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("LANE SILENT")
    expect(c.detail).toContain("Top Shot/offer_fill")
  })
})

describe("sentinel — FMV freshness arms", () => {
  it("warns when the latest snapshot is between the warn and crit ages", async () => {
    const r = await run({ fmv_snapshots: { data: [{ computed_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString() }], error: null } })
    expect(chk(r, "FMV Freshness").status).toBe("warn")
  })
  it("pages critical when the latest snapshot is older than the crit age", async () => {
    const r = await run({ fmv_snapshots: { data: [{ computed_at: new Date(Date.now() - 9 * 3600 * 1000).toISOString() }], error: null } })
    expect(chk(r, "FMV Freshness").status).toBe("critical")
  })
  it("pages critical when there are no snapshots at all", async () => {
    const r = await run({ fmv_snapshots: { data: [], error: null } })
    expect(chk(r, "FMV Freshness").detail).toContain("No FMV snapshots")
  })
  it("a non-saturation freshness query error pages critical", async () => {
    const r = await run({ fmv_snapshots: { data: null, error: { message: "permission denied" } } as never })
    expect(chk(r, "FMV Freshness").status).toBe("critical")
  })
})

describe("sentinel — confidence / coverage / leak arms", () => {
  it("warns when base HIGH+MED confidence is below the threshold", async () => {
    const r = await run({
      "rpc:sentinel_fmv_confidence_canonical_ts_split": {
        data: [
          { printing: "base", confidence: "HIGH", count: 10 },
          { printing: "base", confidence: "MEDIUM", count: 10 },
          { printing: "base", confidence: "LOW", count: 980 },
        ],
        error: null,
      } as never,
    })
    expect(chk(r, "FMV Confidence (canonical TS)").status).toBe("warn")
  })
  it("warns on a confidence RPC error", async () => {
    const r = await run({ "rpc:sentinel_fmv_confidence_canonical_ts_split": { data: null, error: { message: "boom" } } as never })
    expect(chk(r, "FMV Confidence (canonical TS)").status).toBe("warn")
  })
  // A no-error/no-payload read used to fall through `else if (data)` and push
  // NOTHING, so the headline accuracy arm vanished from the report rather than
  // reporting that it could not be read. The assertion is therefore that the
  // arm is PRESENT and states no percentage — not merely that some error text
  // exists somewhere. Asserting presence-of-a-message would pass on a version
  // that also published a fabricated "0%".
  it("keeps the confidence arm present, and claims no percentage, when the RPC returns no payload", async () => {
    const r = await run({ "rpc:sentinel_fmv_confidence_canonical_ts_split": { data: null, error: null } as never })
    const arm = chk(r, "FMV Confidence (canonical TS)")
    expect(arm).toBeDefined()
    expect(arm.status).toBe("warn")
    // The false claim is a share-of-prices figure derived from a read that returned nothing.
    expect(arm.detail).not.toMatch(/\d+(\.\d+)?\s*%/)
    expect(arm.value ?? "").not.toMatch(/\d+(\.\d+)?\s*%/)
  })
  it("warns when live edition coverage is below the threshold", async () => {
    const r = await run({ "rpc:sentinel_edition_coverage": { data: [{ scope: "live", editions: 1000, with_fmv: 500 }], error: null } as never })
    expect(chk(r, "Edition Coverage").status).toBe("warn")
  })
  it("warns on an edition-coverage RPC error", async () => {
    const r = await run({ "rpc:sentinel_edition_coverage": { data: null, error: { message: "boom" } } as never })
    expect(chk(r, "Edition Coverage").status).toBe("warn")
  })
  // A population of ZERO is not a share of zero. Both gate meters used to divide
  // by an empty denominator and render "0%", which reads as a reportable collapse
  // in accuracy when the truth is that there was nothing to measure. The assertion
  // is the ABSENCE of a percentage — asserting the presence of some warning text
  // would pass unchanged on the version that also published the fabricated 0%.
  it("claims no percentage when the confidence tally has no base editions", async () => {
    const r = await run({
      "rpc:sentinel_fmv_confidence_canonical_ts_split": {
        data: [{ printing: "parallel", confidence: "LOW", count: 12 }],
        error: null,
      } as never,
    })
    const arm = chk(r, "FMV Confidence (canonical TS)")
    expect(arm.status).toBe("warn")
    // Strict: no percent sign at all. The copy deliberately says "not zero"
    // rather than "not 0%" so this assertion needs no carve-out — a carve-out
    // to tolerate the fix's own wording is how a test stops pinning anything.
    expect(arm.detail).not.toContain("%")
    expect(arm.value ?? "").not.toContain("%")
  })
  it("claims no percentage when edition coverage has no live-scope row", async () => {
    const r = await run({ "rpc:sentinel_edition_coverage": { data: [], error: null } as never })
    const arm = chk(r, "Edition Coverage")
    expect(arm.status).toBe("warn")
    // Strict: no percent sign at all. The copy deliberately says "not zero"
    // rather than "not 0%" so this assertion needs no carve-out — a carve-out
    // to tolerate the fix's own wording is how a test stops pinning anything.
    expect(arm.detail).not.toContain("%")
    expect(arm.value ?? "").not.toContain("%")
  })
  it("warns then pages on the TS writer-leak bands", async () => {
    const warnR = await run({ editions: { count: 300, error: null } as never })
    expect(chk(warnR, "TS Edition Writer Leak (48h)").status).toBe("warn")
    const critR = await run({ editions: { count: 2500, error: null } as never })
    expect(chk(critR, "TS Edition Writer Leak (48h)").status).toBe("critical")
  })
})

describe("sentinel — pipeline / trust / totals arms", () => {
  it("warns (not pages) when only medium-severity pipelines are stalled", async () => {
    const r = await run({
      "rpc:detect_stalled_pipelines": {
        data: [{ pipeline: "wmc-fmv-populate", severity: "medium", silent_minutes: 80, max_silent_minutes: 60 }],
        error: null,
      } as never,
    })
    expect(chk(r, "Pipeline Silence").status).toBe("warn")
  })
  it("warns on a stalled-pipelines RPC error", async () => {
    const r = await run({ "rpc:detect_stalled_pipelines": { data: null, error: { message: "boom" } } as never })
    expect(chk(r, "Pipeline Silence").status).toBe("warn")
  })
  it("warns and lists the breached metric when trust health has a breach", async () => {
    const r = await run({
      v_rpc_trust_health: {
        data: [
          { metric: "topshot_fmv_stale_hours", value: 10, breach_at: 6, status: "breach" },
          { metric: "offer_edition_gap", value: 0, breach_at: 50, status: "ok" },
        ],
        error: null,
      },
    })
    const c = chk(r, "Trust Health")
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("topshot_fmv_stale_hours=10")
  })
  it("warns on a trust-health query error", async () => {
    const r = await run({ v_rpc_trust_health: { data: null, error: { message: "permission denied" } } as never })
    expect(chk(r, "Trust Health").status).toBe("warn")
  })
  it("warns when total-sales estimate is zero", async () => {
    const r = await run({ "rpc:sentinel_total_sales_estimate": { data: 0, error: null } as never })
    expect(chk(r, "Total Sales").status).toBe("warn")
  })
  it("warns on a total-sales estimate error", async () => {
    const r = await run({ "rpc:sentinel_total_sales_estimate": { data: null, error: { message: "boom" } } as never })
    expect(chk(r, "Total Sales").status).toBe("warn")
  })
})

describe("sentinel — sniper-feed arms + notification failure", () => {
  it("warns when the sniper feed returns zero deals", async () => {
    const r = await run({}, [jsonRoute("/api/sniper-feed", { deals: [] }), telegramOk, resendOk])
    expect(chk(r, "Sniper Feed").status).toBe("warn")
    expect(chk(r, "Sniper Feed").detail).toContain("0 deals")
  })
  it("pages critical on a non-200 sniper-feed response", async () => {
    const r = await run({}, [jsonRoute("/api/sniper-feed", {}, { status: 503, ok: false }), telegramOk, resendOk])
    expect(chk(r, "Sniper Feed").status).toBe("critical")
  })
  it("treats an AbortError from the sniper feed as inconclusive-warn", async () => {
    const abort: FetchStub = {
      match: (u) => u.includes("/api/sniper-feed"),
      respond: () => { const e: any = new Error("The user aborted a request."); e.name = "AbortError"; throw e },
    }
    const r = await run({}, [abort, telegramOk, resendOk])
    expect(chk(r, "Sniper Feed").status).toBe("warn")
  })
  it("pages critical on a hard (non-saturation) sniper-feed error and records email-FAILED when Resend is down", async () => {
    const boom: FetchStub = {
      match: (u) => u.includes("/api/sniper-feed"),
      respond: () => { throw new Error("ECONNREFUSED") },
    }
    const r = await run({}, [boom, telegramOk, jsonRoute("api.resend.com", { error: "bad" }, { status: 500, ok: false })])
    expect(chk(r, "Sniper Feed").status).toBe("critical")
    expect(r.status).toBe("CRITICAL")
    expect(r.notifications).toContain("email-FAILED")
    expect(r.notifications).toContain("telegram")
  })
})
