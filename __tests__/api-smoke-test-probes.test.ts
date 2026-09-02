import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// The smoke battery's probe arms the sibling deep test doesn't reach. Same
// harness shape, different scenarios — this file is about the checks that guard
// DATA-CORRECTNESS rather than reachability:
//
//   - the Pinnacle character probe. `searchPinnacleDeals` is the concierge's
//     Pinnacle lane, and the failure it exists to catch is silent: a filter
//     regression returns the WRONG CHARACTER's pins. It must hard-fail on a leak
//     but degrade to SOFT inconclusive on a transient pool/timeout error (Sentry
//     NEXTJS-13's cry-wolf class).
//     ⚠ Its former sibling — the FMV cross-character drift guard — was RETIRED
//     2026-08-14 as a tautology (it compared the deal rows to the table they came
//     from) after 54 false hard pages. The invariant it was meant to protect is
//     now pinned statically in pinnacle-router-fmv-same-row-guard.test.ts.
//   - the two SMOKE_TEST_SESSION_TOKEN opt-in probes, which self-skip as PASS
//     when the token is unset (so an unconfigured environment can't red the
//     gate) but become real assertions the moment it is set.
//   - checkPublicPage's twice-transient path -> soft inconclusive.
//   - wantsLiveConcierge's explicit query values, and the top-level crash guard
//     on both GET and POST (which must still answer 200 with a failing result,
//     because the CI gate parses the body).

const state = vi.hoisted(() => ({
  svc: null as unknown,
  clientThrows: false,
  pinnacleJson: JSON.stringify({ status: "no_results" }),
  opsAlerts: [] as Array<{ key: string }>,
  sentryExceptions: 0,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, key: string) => {
    if (state.clientThrows) throw new Error("supabase client construction failed")
    return key === process.env.SUPABASE_SERVICE_ROLE_KEY
      ? new Proxy({}, { get: (_t, prop) => (state.svc as Record<PropertyKey, unknown>)[prop] })
      : { from: () => ({ insert: async () => ({ error: { code: "42501", message: "row-level security" } }) }) }
  },
}))
vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (s: { setTag: () => void; setExtra: () => void }) => void) => cb({ setTag: () => {}, setExtra: () => {} }),
  captureMessage: () => {},
  captureException: () => {
    state.sentryExceptions++
  },
}))
vi.mock("@/lib/ops-alert", () => ({
  sendOpsAlert: async (a: { key: string }) => {
    state.opsAlerts.push(a)
    return { suppressed: false, telegram: true, email: true }
  },
}))
vi.mock("@/lib/concierge/pinnacle-router", () => ({
  searchPinnacleDeals: async () => state.pinnacleJson,
}))

process.env.NEXT_PUBLIC_APP_URL = "https://smoke.test"
process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
delete process.env.SMOKE_TEST_SESSION_TOKEN

const { GET, POST } = await import("@/app/api/smoke-test/route")

interface StubResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
  throws?: Error
}
interface SmokeStub {
  match: (url: string, init?: RequestInit) => boolean
  respond: (url: string, init?: RequestInit) => StubResponse
}

function installSmokeFetch(stubs: SmokeStub[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url?: unknown })?.url ?? input)
    calls.push({ url, init })
    const stub = stubs.find((s) => s.match(url, init))
    if (!stub) throw new Error(`smoke-probes harness: no fetch stub matched ${url}`)
    const r = stub.respond(url, init)
    if (r.throws) throw r.throws
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? { "content-type": "application/json" }),
      text: async () => r.body ?? '{"ok":true}',
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

function greenStubs(overrides: SmokeStub[] = []): SmokeStub[] {
  return [
    ...overrides,
    htmlStub("/nba-top-shot/pack/dist/5048", "<html><h2>Sales History</h2>20 rows</html>"),
    htmlStub("/nfl-all-day/edition/446", "<html><h2>Activity</h2>sales table</html>"),
    { match: (u) => u.includes("/api/og/collection"), respond: () => ({ headers: { "content-type": "image/png" }, body: "png-bytes" }) },
    { match: (u) => u === "https://smoke.test/profile", respond: () => ({ status: 200, body: "<main>Look up any collector. No account needed.</main>" }) }, // R36: /profile is the anon entry page now, not a 308 to the auth-gated dashboard
    jsonStub("/api/sniper-feed", { deals: [{ source: "flowty", listingResourceID: "123", storefrontAddress: "0xabc", askPrice: 12.5 }] }),
    jsonStub("/api/market", { listings: [{ id: "l1" }, { id: "l2" }] }),
    jsonStub("/api/profile/resolve-and-associate", { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["topshot", "allday", "golazos", "ufc"] }),
    { match: (u) => u.includes("/api/support-chat"), respond: () => ({ body: JSON.stringify({ response: "The concierge is temporarily unavailable — please try again shortly.", category: "concierge_unavailable" }) }) },
    { match: () => true, respond: () => ({ body: '{"ok":true}' }) },
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function greenFixtures(over: Fixtures = {}): Fixtures {
  return {
    "rpc:detect_stalled_pipelines": { data: [], error: null },
    "rpc:analytics_pipeline_health": { data: { pipelines: { fmv: { status: "healthy", lag_minutes: 4, expected_max_lag_min: 90 } } }, error: null },
    "rpc:check_secdef_anon_execute_violations": { data: [], error: null },
    // {inspected, offenders} — the one guard RPC returning a jsonb OBJECT.
    // `inspected` must clear the arm's own not-vacuous floor (20).
    "rpc:check_cron_heavy_job_exec_drift": { data: { inspected: 56, offenders: [] }, error: null },
    "rpc:check_public_security_invariants": { data: [], error: null },
    cached_listings: { count: 24, error: null } as unknown as { data?: unknown; error?: unknown },
    smoke_test_results: { data: null, error: null },
    pinnacle_catalog: { data: [], error: null },
    ...over,
  }
}
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.svc = spy.fixture
  return spy
}

interface SmokeResult {
  name: string
  passed: boolean
  soft?: boolean
  detail?: string
  notes?: Record<string, unknown> | null
}
interface Envelope {
  allPassed: boolean
  hardPassed: number
  hardTotal: number
  softFailures: number
  liveConcierge: boolean
  results: SmokeResult[]
}

async function run(query = ""): Promise<Envelope> {
  const res = await GET(new Request(`https://smoke.test/api/smoke-test${query}`))
  expect(res.status).toBe(200)
  return (await res.json()) as Envelope
}
function find(env: Envelope, name: string): SmokeResult {
  const r = env.results.find((x) => x.name === name)
  if (!r) throw new Error(`result not found: ${name}`)
  return r
}

const CHAR_PROBE = "Pinnacle searchPinnacleDeals filters character_name correctly"
const AUTHED_PAGE = "authed /nba-top-shot/collection renders (opt-in via SMOKE_TEST_SESSION_TOKEN)"
const HERO = "/api/profile/hero-moment returns populated hero (opt-in via SMOKE_TEST_SESSION_TOKEN)"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-17T12:00:00.000Z") })
  state.opsAlerts = []
  state.sentryExceptions = 0
  state.clientThrows = false
  state.pinnacleJson = JSON.stringify({ status: "no_results" })
  delete process.env.SMOKE_TEST_SESSION_TOKEN
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.SMOKE_TEST_SESSION_TOKEN
})

// ⚠ The sibling "Pinnacle FMV not borrowed across characters (drift guard)" was
// RETIRED 2026-08-14 and its cases removed from this file. It compared the deal
// rows to pinnacle_catalog — which is where the deal rows came from — so it was
// guaranteed to pass and still hard-paged 54 times. The invariant that makes the
// leak impossible is pinned statically instead, in
// __tests__/pinnacle-router-fmv-same-row-guard.test.ts. Do not re-add a runtime
// probe here without first re-reading that file's header: the obvious
// cross-source (pinnacle_fmv_history) is a trigger-written copy of the same
// table, not an independent one.
describe("smoke-test — Pinnacle character probe", () => {
  const goofyRow = { player: "Goofy", set: "Hero Set", tier: "Standard", fmv: 12 }

  it("passes when every row is the requested character", async () => {
    state.pinnacleJson = JSON.stringify({ status: "ok", results: [goofyRow] })
    install(greenFixtures({ pinnacle_catalog: { data: [{ character_name: "Goofy", set_name: " Hero Set ", variant: "STANDARD" }], error: null } }))
    installSmokeFetch(greenStubs())

    const env = await run()
    expect(find(env, CHAR_PROBE)).toMatchObject({ passed: true, detail: "1 rows, all goofy" })
  })

  it("hard-fails the character probe when a foreign character leaks into the results", async () => {
    state.pinnacleJson = JSON.stringify({ status: "ok", results: [goofyRow, { player: "Mickey", set: "Hero Set", tier: "Standard", fmv: 20 }] })
    install(greenFixtures({ pinnacle_catalog: { data: [{ character_name: "Goofy", set_name: "Hero Set", variant: "Standard" }, { character_name: "Mickey", set_name: "Hero Set", variant: "Standard" }], error: null } }))
    installSmokeFetch(greenStubs())

    const r = find(await run(), CHAR_PROBE)
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy()
    expect(r.detail).toContain("non-goofy row(s) leaked")
    expect(r.detail).toContain("Mickey")
  })

  it("degrades to soft inconclusive on a transient pool error", async () => {
    state.pinnacleJson = JSON.stringify({ status: "error", message: "Timed out acquiring connection from connection pool" })
    install(greenFixtures())
    installSmokeFetch(greenStubs())

    const env = await run()
    const r = find(env, CHAR_PROBE)
    expect(r.passed).toBe(false)
    expect(r.soft).toBe(true)
    expect(r.notes?.warn).toBe("pinnacle_transient")
    // Soft failures never page.
    expect(state.opsAlerts).toHaveLength(0)
  })

  it("hard-fails on a non-transient unexpected status", async () => {
    state.pinnacleJson = JSON.stringify({ status: "error", message: "column does not exist" })
    install(greenFixtures())
    installSmokeFetch(greenStubs())

    const env = await run()
    const r = find(env, CHAR_PROBE)
    expect(r.passed).toBe(false)
    expect(r.soft).toBeFalsy()
    expect(r.detail).toContain("unexpected status: error")
  })
})

describe("smoke-test — SMOKE_TEST_SESSION_TOKEN opt-in probes", () => {
  it("self-skips as PASS when the token is unset, so an unconfigured env cannot red the gate", async () => {
    install(greenFixtures())
    installSmokeFetch(greenStubs())
    const env = await run()
    for (const name of [AUTHED_PAGE, HERO]) {
      expect(find(env, name)).toMatchObject({ passed: true, notes: { skipped: true } })
    }
  })

  it("becomes a real assertion once the token is set", async () => {
    process.env.SMOKE_TEST_SESSION_TOKEN = "sess-token"
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([
        { match: (u) => u.includes("/nba-top-shot/collection"), respond: () => ({ headers: { "content-type": "text/html" }, body: "<html>COLLECTION ANALYZER</html>" }) },
        { match: (u) => u.includes("/api/profile/hero-moment"), respond: () => ({ body: JSON.stringify({ hero: { momentId: "m1", playerName: "Dame", fmvUsd: 42.5 } }) }) },
      ]),
    )
    const env = await run()
    expect(find(env, AUTHED_PAGE)).toMatchObject({ passed: true, detail: "auth render ok" })
    expect(find(env, HERO).detail).toContain("Dame $42.50")
  })

  it("fails the authed probes on a missing content marker and a malformed hero body", async () => {
    process.env.SMOKE_TEST_SESSION_TOKEN = "sess-token"
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([
        { match: (u) => u.includes("/nba-top-shot/collection"), respond: () => ({ headers: { "content-type": "text/html" }, body: "<html>login wall</html>" }) },
        { match: (u) => u.includes("/api/profile/hero-moment"), respond: () => ({ body: JSON.stringify({ reason: "no_wallet" }) }) },
      ]),
    )
    const env = await run()
    expect(find(env, AUTHED_PAGE)).toMatchObject({ passed: false, detail: "content marker missing" })
    expect(find(env, HERO)).toMatchObject({ passed: false, detail: "no_wallet" })
  })

  it("fails the authed probes on a non-200", async () => {
    process.env.SMOKE_TEST_SESSION_TOKEN = "sess-token"
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([
        { match: (u) => u.includes("/nba-top-shot/collection"), respond: () => ({ status: 302, body: "" }) },
        { match: (u) => u.includes("/api/profile/hero-moment"), respond: () => ({ status: 401, body: "nope" }) },
      ]),
    )
    const env = await run()
    expect(find(env, AUTHED_PAGE).detail).toBe("HTTP 302")
    expect(find(env, HERO).detail).toBe("HTTP 401")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A LATENCY MISS MUST NOT READ AS AN AUTH FAILURE.
// The `after()` probe applied its 3 s budget to every status and reported
// `HTTP ${status} in ${ms}ms`, so a COLD-START 401 at 3,030 ms — 30 ms over, on
// a path that short-circuits at the auth gate and never reaches the four
// parallel wallet searches — hard-failed the workflow with
// `HARD FAIL: … — HTTP 401 in 3030ms`. That sends the reader to the wrong
// subsystem (observed 2026-09-02; it did, for several minutes).
// ⚠ Timers are faked here, so `elapsed` is 0 and the too-slow branch cannot
// fire. What these pin is the part that was actually wrong: WHICH statuses the
// budget applies to, and whether the result says the property went untested.
// ─────────────────────────────────────────────────────────────────────────────
const AFTER_PROBE =
  "/api/profile/resolve-and-associate responds non-5xx (after() budget applies only to a 200)"

describe("smoke-test — the after() probe separates 'not exercised' from 'too slow'", () => {
  it("a 401 passes and SAYS the after() property was never exercised", async () => {
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([jsonStub("/api/profile/resolve-and-associate", { error: "Unauthorized" }, 401)]),
    )
    const r = find(await run(), AFTER_PROBE)
    expect(r.passed).toBe(true)
    // ⛔ The load-bearing half: the result must not imply the property held.
    expect(r.notes?.after_exercised).toBe(false)
    expect(r.detail).toContain("after() NOT exercised")
  })

  it("a 200 marks the property as actually exercised", async () => {
    install(greenFixtures())
    installSmokeFetch(greenStubs())
    const r = find(await run(), AFTER_PROBE)
    expect(r.passed).toBe(true)
    expect(r.notes?.after_exercised).toBe(true)
  })

  it("a 5xx still hard-fails, and its detail names the STATUS rather than the clock", async () => {
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([jsonStub("/api/profile/resolve-and-associate", { error: "boom" }, 503)]),
    )
    const r = find(await run(), AFTER_PROBE)
    expect(r.passed).toBe(false)
    expect(r.detail).toContain("server error")
    expect(r.notes?.after_exercised).toBe(false)
  })
})

describe("smoke-test — envelope + crash guards", () => {
  it("classifies a twice-timing-out public page as soft inconclusive rather than a regression", async () => {
    install(greenFixtures())
    installSmokeFetch(
      greenStubs([
        {
          match: (u) => u === "https://smoke.test/nba-top-shot/market",
          respond: () => ({ throws: new Error("The operation was aborted due to timeout") }),
        },
      ]),
    )
    const r = find(await run(), "public page /nba-top-shot/market returns 200")
    expect(r.passed).toBe(false)
    expect(r.soft).toBe(true)
    expect(r.notes?.warn).toBe("page_timeout_transient")
  })

  it("arms the live-concierge probes on every explicit query value", async () => {
    for (const q of ["?concierge=1", "?concierge=true", "?concierge=full", "?concierge=live"]) {
      install(greenFixtures())
      installSmokeFetch(greenStubs())
      expect((await run(q)).liveConcierge).toBe(true)
    }
    install(greenFixtures())
    installSmokeFetch(greenStubs())
    expect((await run("?concierge=0")).liveConcierge).toBe(false)
  })

  it("answers 200 with a failing result when the battery itself crashes, on GET and POST", async () => {
    // The CI gate parses the BODY, so a crash must never become a non-200 the
    // gate would read as a transport error instead of a failure.
    state.clientThrows = true
    installSmokeFetch(greenStubs())

    for (const [label, res] of [
      ["GET", await GET(new Request("https://smoke.test/api/smoke-test"))],
      ["POST", await POST(new Request("https://smoke.test/api/smoke-test", { method: "POST" }))],
    ] as const) {
      expect(res.status, label).toBe(200)
      const body = (await res.json()) as { allPassed: boolean; results: SmokeResult[] }
      expect(body.allPassed).toBe(false)
      expect(body.results[0].detail).toContain("supabase client construction failed")
    }
    expect(state.sentryExceptions).toBe(2)
  })
})
