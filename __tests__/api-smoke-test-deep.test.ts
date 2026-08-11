import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive test for GET /api/smoke-test — the hourly production smoke battery.
//
// Drives the FULL runSmokeTests() probe suite (55 checks per-tick, 58 with
// ?concierge=1) against a fixtured world and asserts on handler-COMPUTED output:
// the severity envelope (allPassed / hardPassed / hardTotal / softFailures),
// per-check pass/fail/soft-inconclusive classification, retry behavior, the
// Sentry + ops-alert dispatch decisions, and the smoke_test_results persistence.
//
// Deliberately NOT duplicated here (already pinned elsewhere):
//   - checkHtmlContains / smokeFetchRetry unit behavior in isolation
//     (__tests__/api-smoke-test-html-contains.test.ts). This file instead drives
//     the same incident classes THROUGH the route and asserts the envelope +
//     alert integration.
//
// Discovery worth knowing: the route has NO auth guard of its own — GET/POST go
// straight into runSmokeTests() (proxy.ts gates the path in production). So the
// "auth guard" scenario is inapplicable; what IS a contract is the OUTBOUND
// auth: smokeFetch must inject `Authorization: Bearer ${INGEST_SECRET_TOKEN}`
// on every self-probe so authed routes are exercised instead of bouncing to
// /login. That contract is asserted in the green-run test.
//
// The route's fetch surface needs headers support (og content-type, /profile
// 308 location, checkPublicPage's notes.location runs even on PASS), which the
// shared installFetchMock's Response stub lacks — so this file carries its own
// headers-capable fetch stub, same match-first / unmatched-throws / catch-all-
// last shape as the shared harness.

const state = vi.hoisted(() => ({
  svc: null as unknown,
  anonInsertResult: { error: { code: "42501", message: "row-level security" } } as {
    error: { code: string; message: string } | null
  },
  pinnacleJson: JSON.stringify({ status: "no_results" }),
  opsAlerts: [] as Array<{ key: string; subject: string; text: string }>,
  sentryMessages: [] as string[],
}))

vi.mock("@supabase/supabase-js", () => ({
  // The route builds two clients: the service client (all health RPCs + the
  // smoke_test_results write) and a fresh ANON client per RLS write-block probe.
  createClient: (_url: string, key: string) =>
    key === process.env.SUPABASE_SERVICE_ROLE_KEY
      ? new Proxy({}, { get: (_t, prop) => (state.svc as Record<PropertyKey, unknown>)[prop] })
      : { from: () => ({ insert: async () => state.anonInsertResult }) },
}))

vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (scope: { setTag: (k: string, v: string) => void; setExtra: (k: string, v: unknown) => void }) => void) =>
    cb({ setTag: () => {}, setExtra: () => {} }),
  captureMessage: (msg: string) => {
    state.sentryMessages.push(msg)
  },
  captureException: () => {},
}))

vi.mock("@/lib/ops-alert", () => ({
  sendOpsAlert: async (alert: { key: string; subject: string; text: string }) => {
    state.opsAlerts.push(alert)
    return { suppressed: false, telegram: true, email: true }
  },
}))

vi.mock("@/lib/concierge/pinnacle-router", () => ({
  searchPinnacleDeals: async () => state.pinnacleJson,
}))

// Module-level env capture: BASE_URL + INGEST_SECRET_TOKEN + SMOKE_TEST_SESSION_
// TOKEN are read into consts at import time, so set them BEFORE the dynamic
// import. No SMOKE_TEST_SESSION_TOKEN ⇒ the two opt-in authed probes self-skip
// (pass) and the X-RPC-Smoke-Test header is not injected.
process.env.NEXT_PUBLIC_APP_URL = "https://smoke.test"
process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
delete process.env.SMOKE_TEST_SESSION_TOKEN

const { GET } = await import("@/app/api/smoke-test/route")

// ── Headers-capable fetch stub (match-first; unmatched throws; catch-all last) ──

interface StubResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
  /** When set, res.text() REJECTS with this error — the streamed-body-abort case. */
  bodyError?: Error
}
interface SmokeStub {
  match: (url: string, init?: RequestInit) => boolean
  respond: (url: string, init?: RequestInit) => StubResponse
}

function installSmokeFetch(stubs: SmokeStub[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? input)
    calls.push({ url, init })
    const stub = stubs.find((s) => s.match(url, init))
    if (!stub) throw new Error(`smoke-deep harness: no fetch stub matched ${url}`)
    const r = stub.respond(url, init)
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? { "content-type": "application/json" }),
      text: async () => {
        if (r.bodyError) throw r.bodyError
        return r.body ?? '{"ok":true}'
      },
      json: async () => JSON.parse(r.body ?? '{"ok":true}'),
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fn)
  return { calls }
}

const htmlStub = (substr: string, body: string): SmokeStub => ({
  match: (u) => u.includes(substr),
  respond: () => ({ headers: { "content-type": "text/html" }, body }),
})
const jsonStub = (substr: string, obj: unknown, status = 200): SmokeStub => ({
  match: (u) => u.includes(substr),
  respond: () => ({ status, body: JSON.stringify(obj) }),
})
/** Sequence-aware stub: each call consumes the next response (last repeats). */
const seqStub = (substr: string, pages: StubResponse[]): SmokeStub => {
  let i = 0
  return { match: (u) => u.includes(substr), respond: () => pages[Math.min(i++, pages.length - 1)] }
}

// Streamed-body abort — same message shape AbortSignal.timeout produces, which
// isTimeoutOrTransient classifies as transient.
const streamAbortErr = () => new Error("The operation was aborted due to timeout")

// One support-chat stub serves all three shapes the suite can send: the
// synthetic-degradation probe (dispatched on its x-rpc-test-error-mode header)
// and the two live-concierge name-filter probes (dispatched on message body).
const supportChatStub = (): SmokeStub => ({
  match: (u) => u.includes("/api/support-chat"),
  respond: (_u, init) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit)
    const reqBody = typeof init?.body === "string" ? init.body : ""
    if (headers.get("x-rpc-test-error-mode") === "credit_balance") {
      return {
        body: JSON.stringify({
          response: "The concierge is temporarily unavailable — please try again shortly.",
          category: "concierge_unavailable",
        }),
      }
    }
    if (/Goofy/i.test(reqBody)) {
      return { body: JSON.stringify({ response: "Found a Goofy pin: Goofy Hero at $12.00 ask.", category: "deal_search" }) }
    }
    if (/LeBron/i.test(reqBody)) {
      return { body: JSON.stringify({ response: "LeBron James Common available at $4.", category: "deal_search" }) }
    }
    return { body: JSON.stringify({ response: "ok", category: "chat" }) }
  },
})

// Fully-green stub set. `overrides` go FIRST so they shadow the green versions.
function greenStubs(overrides: SmokeStub[] = []): SmokeStub[] {
  return [
    ...overrides,
    htmlStub("/nba-top-shot/pack/dist/5048", "<html><h2>Sales History</h2>20 rows</html>"),
    htmlStub("/nfl-all-day/edition/446", "<html><h2>Activity</h2>sales table</html>"),
    { match: (u) => u.includes("/api/og/collection"), respond: () => ({ headers: { "content-type": "image/png" }, body: "png-bytes" }) },
    { match: (u) => u === "https://smoke.test/profile", respond: () => ({ status: 308, headers: { location: "https://smoke.test/dashboard" } }) },
    jsonStub("/api/sniper-feed", {
      deals: [{ source: "flowty", listingResourceID: "123", storefrontAddress: "0xabc", askPrice: 12.5 }],
    }),
    jsonStub("/api/market", { listings: [{ id: "l1" }, { id: "l2" }] }),
    jsonStub("/api/profile/resolve-and-associate", {
      walletAddress: "0xbd94cade097e50ac",
      associatedCollections: ["topshot", "allday", "golazos", "ufc"],
    }),
    supportChatStub(),
    // Catch-all LAST: generic healthy JSON (parses as an object for the
    // expectJson probes; 200 status satisfies the page probes).
    { match: () => true, respond: () => ({ body: '{"ok":true}' }) },
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function greenFixtures(): Fixtures {
  return {
    "rpc:detect_stalled_pipelines": { data: [], error: null },
    "rpc:analytics_pipeline_health": {
      data: { pipelines: { fmv: { status: "healthy", lag_minutes: 4, expected_max_lag_min: 90 } } },
      error: null,
    },
    "rpc:check_secdef_anon_execute_violations": { data: [], error: null },
    "rpc:check_public_security_invariants": { data: [], error: null },
    cached_listings: { count: 24, error: null } as unknown as { data?: unknown; error?: unknown },
    smoke_test_results: { data: null, error: null },
  }
}

function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.svc = spy.fixture
  return spy
}

interface SmokeResult {
  name: string
  endpoint: string
  passed: boolean
  soft?: boolean
  /** Check errored before evaluating its assertion (vs. ran and found a violation). */
  couldNotRun?: boolean
  detail?: string
  statusCode?: number | null
  notes?: Record<string, unknown> | null
}
interface Envelope {
  passed: number
  total: number
  allPassed: boolean
  hardPassed: number
  hardTotal: number
  softFailures: number
  liveConcierge: boolean
  ranAt: string
  results: SmokeResult[]
}

function findResult(env: Envelope, name: string): SmokeResult {
  const r = env.results.find((x) => x.name === name)
  if (!r) throw new Error(`result not found: ${name}`)
  return r
}

async function run(query = ""): Promise<Envelope> {
  const res = await GET(new Request(`https://smoke.test/api/smoke-test${query}`))
  expect(res.status).toBe(200)
  return (await res.json()) as Envelope
}

const hits = (calls: Array<{ url: string }>, substr: string) => calls.filter((c) => c.url.includes(substr)).length

beforeEach(() => {
  // Freeze ONLY Date (setTimeout stays real so the retry sleeps still resolve):
  // 12:00 UTC keeps wantsLiveConcierge's 09:00–09:24 daily window from
  // non-deterministically arming the live-LLM probes.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-17T12:00:00.000Z") })
  state.opsAlerts = []
  state.sentryMessages = []
  state.anonInsertResult = { error: { code: "42501", message: "row-level security" } }
  state.pinnacleJson = JSON.stringify({ status: "no_results" })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("GET /api/smoke-test — deep drive of the full battery", () => {
  it("fully-green run: 55/55 (hard 43/43), rows persisted ok:true, no alert dispatch, bearer injected, concierge probes gated OFF", async () => {
    const spy = install(greenFixtures())
    const { calls } = installSmokeFetch(greenStubs())

    const env = await run()

    // Envelope: every probe that runs per-tick passes.
    // (55 = 54 historical + /insights/candy-mlb (2026-07-31 Candy go-live) +
    // /insights/panini-squeeze (2026-08-01 Panini go-live) — each a hard
    // 200-status public-page check — MINUS the /api/cart/validate probe, dropped
    // 2026-08-01 with the read-only cart/gift/trade teardown.)
    expect(env.total).toBe(55)
    expect(env.passed).toBe(55)
    expect(env.allPassed).toBe(true)
    expect(env.hardTotal).toBe(43) // 12 checks are soft-flagged in a green run
    expect(env.hardPassed).toBe(43)
    expect(env.softFailures).toBe(0)
    expect(env.liveConcierge).toBe(false)
    expect(env.results.every((r) => r.passed)).toBe(true)

    // The live-LLM concierge probes must NOT run on a per-tick (ungated) call.
    const names = env.results.map((r) => r.name)
    expect(names).not.toContain("concierge resolves Pinnacle query (collectionId routing)")
    expect(names).not.toContain("concierge filters by character name (Pinnacle Goofy probe)")
    expect(names).not.toContain("concierge filters by player name (Top Shot LeBron probe)")
    // Representative computed classifications.
    expect(findResult(env, "pack dist page has Sales History").statusCode).toBe(200)
    expect(findResult(env, "market API returns Top Shot listings").detail).toBe("2 listings")
    expect(findResult(env, "sales indexers running (detect_stalled_pipelines)").detail).toContain(
      "all sales indexers within their max-silent window",
    )
    // Opt-in authed probes self-skip (pass) without SMOKE_TEST_SESSION_TOKEN.
    expect(findResult(env, "authed /nba-top-shot/collection renders (opt-in via SMOKE_TEST_SESSION_TOKEN)").notes).toEqual({ skipped: true })

    // Persistence: one insert of all structured rows, all ok, stamped with ranAt.
    const writes = spy.writes["smoke_test_results"]
    expect(writes).toHaveLength(1)
    expect(writes[0].rows).toHaveLength(55)
    expect(writes[0].rows.every((r) => r.ok === true && r.error === null)).toBe(true)
    expect(writes[0].rows[0].ran_at).toBe(env.ranAt)

    // No hard failures ⇒ no ops page, no Sentry capture.
    expect(state.opsAlerts).toHaveLength(0)
    expect(state.sentryMessages).toHaveLength(0)

    // Outbound-auth contract: every self-probe carries the proxy-bypass bearer.
    const probe = calls.find((c) => c.url.includes("/api/pack-listings"))
    expect(probe).toBeDefined()
    expect(new Headers(probe!.init?.headers as HeadersInit).get("authorization")).toBe("Bearer test-ingest-secret")
  })

  it("a 200 body that fully reads but genuinely lacks the needle HARD-fails, pages ops + Sentry, persists ok:false", async () => {
    const spy = install(greenFixtures())
    installSmokeFetch(greenStubs([htmlStub("/nba-top-shot/pack/dist/5048", "<html>shell only, module regressed</html>")]))

    const env = await run()

    const r = findResult(env, "pack dist page has Sales History")
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy() // real module regression must stay HARD
    expect(r.detail).toContain("Sales History=false")
    expect(env.allPassed).toBe(false)
    expect(env.hardPassed).toBe(env.hardTotal - 1)

    // Dispatch decisions: exactly one Sentry capture + one debounced ops page
    // naming the failing endpoint.
    expect(state.sentryMessages).toEqual(["smoke test failed: pack dist page has Sales History"])
    expect(state.opsAlerts).toHaveLength(1)
    expect(state.opsAlerts[0].key).toBe("smoke-test")
    expect(state.opsAlerts[0].subject).toContain("1 hard failure")
    expect(state.opsAlerts[0].text).toContain("/nba-top-shot/pack/dist/5048")

    const row = spy.writes["smoke_test_results"][0].rows.find((x) => x.endpoint === "/nba-top-shot/pack/dist/5048")
    expect(row?.ok).toBe(false)
    expect(String(row?.error)).toContain("Sales History=false")
  })

  it("streamed-body abort (2026-07-16 class): retried once then SOFT inconclusive through the route — never a page", async () => {
    install(greenFixtures())
    const { calls } = installSmokeFetch(
      greenStubs([
        {
          // Headers arrive (200) but the streamed body read rejects — both attempts.
          match: (u) => u.includes("/nba-top-shot/pack/dist/5048"),
          respond: () => ({ headers: { "content-type": "text/html" }, bodyError: streamAbortErr() }),
        },
      ]),
    )

    const env = await run()

    const r = findResult(env, "pack dist page has Sales History")
    expect(r.passed).toBe(false)
    expect(r.soft).toBe(true)
    expect(r.notes?.inconclusive).toBe(true)
    expect(r.notes?.warn).toBe("page_stream_timeout_transient")
    expect(hits(calls, "/nba-top-shot/pack/dist/5048")).toBe(2) // fetch + exactly one retry

    // Soft-inconclusive keeps the envelope green and dispatches nothing.
    expect(env.allPassed).toBe(true)
    expect(env.softFailures).toBeGreaterThanOrEqual(1)
    expect(state.opsAlerts).toHaveLength(0)
    expect(state.sentryMessages).toHaveLength(0)
  })

  it("an API probe returning a non-transient 500 HARD-fails un-retried, while market green-but-empty stays a soft warn", async () => {
    install(greenFixtures())
    const { calls } = installSmokeFetch(
      greenStubs([
        jsonStub("/api/pack-listings", { error: "boom" }, 500),
        jsonStub("/api/market", { listings: [] }), // green-but-empty every call
      ]),
    )

    const env = await run()

    const pack = findResult(env, "pack-listings responds")
    expect(pack.passed).toBe(false)
    expect(pack.soft).toBeFalsy()
    expect(pack.statusCode).toBe(500)
    expect(hits(calls, "/api/pack-listings")).toBe(1) // 500 is NOT in the transient-retry set

    const market = findResult(env, "market API returns Top Shot listings")
    expect(market.passed).toBe(false)
    expect(market.soft).toBe(true) // tsCount:0 class — upstream-transient, never pages
    expect(market.notes?.warn).toBe("ts_proxy_empty")
    expect(hits(calls, "/api/market")).toBe(2) // 200-empty is retried once

    // Only the hard 500 reaches the dispatch paths.
    expect(env.results.filter((r) => !r.passed && !r.soft).map((r) => r.endpoint)).toEqual(["/api/pack-listings"])
    expect(state.sentryMessages).toEqual(["smoke test failed: pack-listings responds"])
    expect(state.opsAlerts).toHaveLength(1)
    expect(state.opsAlerts[0].text).toContain("/api/pack-listings (500)")
  })

  it("transient 503s: an API probe retries to green; a persistently-503 public page classifies soft-inconclusive", async () => {
    install(greenFixtures())
    const { calls } = installSmokeFetch(
      greenStubs([
        seqStub("/api/pack-listings", [{ status: 503, body: '{"err":"gateway"}' }, { body: '{"ok":true}' }]),
        jsonStub("/nfl-all-day/overview", { err: "gateway" }, 503), // 503 on every attempt
      ]),
    )

    const env = await run()

    // 503 is in TRANSIENT_STATUS → one retry → recovered pass.
    const pack = findResult(env, "pack-listings responds")
    expect(pack.passed).toBe(true)
    expect(hits(calls, "/api/pack-listings")).toBe(2)

    // Page probe: 503 persists through the retry → soft inconclusive, not a fail.
    const page = findResult(env, "public page /nfl-all-day/overview returns 200")
    expect(page.passed).toBe(false)
    expect(page.soft).toBe(true)
    expect(page.notes?.warn).toBe("page_status_transient")
    expect(page.statusCode).toBe(503)
    expect(hits(calls, "/nfl-all-day/overview")).toBe(2)

    expect(env.allPassed).toBe(true)
    expect(state.opsAlerts).toHaveLength(0)
  })

  it("health-RPC transient error → soft inconclusive after one rpc retry; a security-guard RPC error stays HARD", async () => {
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: null,
      error: { message: "Timed out acquiring connection from connection pool" },
    }
    f["rpc:check_secdef_anon_execute_violations"] = { data: null, error: { message: "function does not exist" } }
    const spy = install(f)
    installSmokeFetch(greenStubs())

    const env = await run()

    // Saturation-class health RPC: retried once (2 rpc calls), then SOFT.
    const sales = findResult(env, "sales indexers running (detect_stalled_pipelines)")
    expect(sales.passed).toBe(false)
    expect(sales.soft).toBe(true)
    expect(sales.notes?.warn).toBe("rpc_transient")
    expect(spy.rpcCalls.filter((c) => c.name === "detect_stalled_pipelines")).toHaveLength(2)

    // Security guard deliberately does NOT get the soft treatment — must page.
    const guard = findResult(env, "anon has no EXECUTE on destructive SECDEF functions")
    expect(guard.passed).toBe(false)
    expect(guard.soft).toBeFalsy()
    expect(guard.detail).toContain("rpc error: function does not exist")
    expect(spy.rpcCalls.filter((c) => c.name === "check_secdef_anon_execute_violations")).toHaveLength(1) // non-transient: no retry

    expect(env.results.filter((r) => !r.passed && !r.soft).map((r) => r.endpoint)).toEqual([
      "rpc:check_secdef_anon_execute_violations",
    ])
    expect(state.opsAlerts).toHaveLength(1)
    expect(state.opsAlerts[0].text).toContain("rpc:check_secdef_anon_execute_violations")

    // ...and it is flagged as never-evaluated, so the Sentry title does not
    // restate the assertion. The guard's NAME is a claim about production
    // ("anon has no EXECUTE on destructive SECDEF functions"); titling an RPC
    // error with it reads as a live security breach. Observed 2026-08-09
    // (JAVASCRIPT-NEXTJS-25) when a pool timeout surfaced under the
    // cursor-stall guard's name during a disk-IO saturation window.
    expect(guard.couldNotRun).toBe(true)
    expect(state.sentryMessages).toEqual([
      "smoke check could not run: anon has no EXECUTE on destructive SECDEF functions",
    ])
    expect(state.sentryMessages[0]).not.toContain("smoke test failed")
  })

  it("health-RPC NON-transient error → HARD fail, but titled 'could not run' (the assertion never evaluated)", async () => {
    const f = greenFixtures()
    // Not in the transient allowlist (no pool/timeout/canceling wording), so
    // softIfTransientRpc keeps it a hard failure — but the RPC still errored, so
    // the check never looked at whether a sales indexer is stalled.
    f["rpc:detect_stalled_pipelines"] = {
      data: null,
      error: { message: "function detect_stalled_pipelines() does not exist" },
    }
    const spy = install(f)
    installSmokeFetch(greenStubs())

    const env = await run()

    const sales = findResult(env, "sales indexers running (detect_stalled_pipelines)")
    expect(sales.passed).toBe(false)
    expect(sales.soft).toBeFalsy() // non-transient stays a HARD fail (still pages)
    expect(sales.couldNotRun).toBe(true) // ...but flagged as never-evaluated
    expect(sales.detail).toContain("rpc error: function detect_stalled_pipelines() does not exist")
    // Non-transient → no retry.
    expect(spy.rpcCalls.filter((c) => c.name === "detect_stalled_pipelines")).toHaveLength(1)

    // The Sentry title must NOT restate the assertion (no indexer was checked).
    expect(state.sentryMessages).toContain(
      "smoke check could not run: sales indexers running (detect_stalled_pipelines)",
    )
    expect(state.sentryMessages).not.toContain(
      "smoke test failed: sales indexers running (detect_stalled_pipelines)",
    )
  })

  it("a guard that RUNS and finds a real violation keeps the assertion-style title (the contrast case)", async () => {
    const f = greenFixtures()
    // No RPC error — the guard evaluates and returns a genuine violation row.
    f["rpc:check_public_security_invariants"] = {
      data: [{ kind: "rls_off", object_name: "public.some_table" }],
      error: null,
    }
    install(f)
    installSmokeFetch(greenStubs())

    const env = await run()

    const guard = findResult(env, "public base tables: RLS on + no anon write")
    expect(guard.passed).toBe(false)
    expect(guard.soft).toBeFalsy()
    // The check DID run, so the assertion-style title is correct and must stay.
    expect(guard.couldNotRun).toBeFalsy()
    expect(state.sentryMessages).toEqual([
      "smoke test failed: public base tables: RLS on + no anon write",
    ])
  })

  it("a stalled *-sales-indexer HARD-fails with the pipeline named; non-sales stalls are filtered out of the check", async () => {
    const f = greenFixtures()
    f["rpc:detect_stalled_pipelines"] = {
      data: [
        { pipeline: "topshot-sales-indexer", silent_minutes: 300, max_silent_minutes: 180 },
        { pipeline: "pinnacle-ask-refresh", silent_minutes: 999, max_silent_minutes: 60 },
      ],
      error: null,
    }
    install(f)
    installSmokeFetch(greenStubs())

    const env = await run()

    const r = findResult(env, "sales indexers running (detect_stalled_pipelines)")
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy()
    expect(r.detail).toContain("topshot-sales-indexer silent 300m (>180m)")
    // Only the sales-indexer stall counts for THIS check; other stalls are not its business.
    expect((r.notes?.stalled as unknown[]).length).toBe(1)
    expect(env.allPassed).toBe(false)
    expect(state.opsAlerts[0]?.text).toContain("rpc:detect_stalled_pipelines.sales-indexers")
  })

  it("RLS regression: an anon insert that SUCCEEDS hard-fails all 4 write-block probes and pages once", async () => {
    state.anonInsertResult = { error: null } // RLS hole: unauthorized write goes through
    install(greenFixtures())
    installSmokeFetch(greenStubs())

    const env = await run()

    const rls = env.results.filter((r) => r.endpoint.startsWith("rls:"))
    expect(rls).toHaveLength(4)
    for (const r of rls) {
      expect(r.passed).toBe(false)
      expect(r.soft).toBeFalsy()
      expect(r.detail).toBe("RLS FAILED — unauthorized write succeeded")
    }
    expect(env.allPassed).toBe(false)
    expect(env.hardPassed).toBe(env.hardTotal - 4)
    // Each regression is a distinct Sentry capture, but ops pages ONCE with all four.
    expect(state.sentryMessages).toHaveLength(4)
    expect(state.opsAlerts).toHaveLength(1)
    expect(state.opsAlerts[0].subject).toContain("4 hard failure(s)")
    for (const t of ["rls:saved_wallets", "rls:profile_bio", "rls:recent_searches", "rls:trophy_moments"]) {
      expect(state.opsAlerts[0].text).toContain(t)
    }
  })

  it("?concierge=1 arms the 3 live-LLM probes (58 total) and reports liveConcierge in the envelope", async () => {
    install(greenFixtures())
    installSmokeFetch(greenStubs())

    const env = await run("?concierge=1")

    expect(env.liveConcierge).toBe(true)
    expect(env.total).toBe(58)
    expect(env.allPassed).toBe(true)
    for (const name of [
      "concierge resolves Pinnacle query (collectionId routing)",
      "concierge filters by character name (Pinnacle Goofy probe)",
      "concierge filters by player name (Top Shot LeBron probe)",
    ]) {
      const r = findResult(env, name)
      expect(r.passed).toBe(true)
      expect(r.soft).toBe(true) // live-LLM probes are always soft — they can never page
    }
  })
})
