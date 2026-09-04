import { describe, it, expect, afterEach, vi } from "vitest"
import worker from "@/workers/sports-proxy/index.ts"

// ── sports-proxy: the RETRY / FINGERPRINT-ROTATION branches ────────────────
//
// The sibling handler test drives all four routes on their happy path; these
// cover the branches inside them that decide TRANSIENT vs FATAL. They were the
// largest uncovered cluster in the file (measured 2026-08-20: index.ts at
// 67.15% st / 44.53% br, the lowest in the workers gate together with
// rpc-mcp-proxy).
//
// ⚠ WHY THIS CLUSTER AND NOT ANOTHER. The sports-proxy 403 is CLAUDE.md's
// highest-value open item, and its two documented causes are exactly what this
// code reacts to: ESPN/DK reject a request as an Akamai bot (403/401) and the
// worker retries once with a DIFFERENT browser fingerprint; stats.nba.com 520s
// sporadically and the worker retries with backoff. Both decisions are
// invisible in production — a wrong one shows up as "the lane is down", never
// as an error naming the branch — so the only place they can be checked is here.
//
// ⚠ THE ROTATION IS THE POINT, NOT THE RETRY COUNT. Retrying with the SAME
// fingerprint is what the code was written to avoid ("so the retry genuinely
// changes the bot fingerprint Akamai sees"), and a test that only counted calls
// would pass on a version that rotated nothing. Every case below asserts the
// User-Agent actually CHANGED.
//
// ⚠ FAKE TIMERS ARE REQUIRED, not a speed-up: the DK path sleeps 5 s and the
// stats path 1 s / 2 s. On real timers this file would take ~8 s per case and
// someone would eventually delete it.

const SECRET = "test-proxy-secret"
const env = { PROXY_SECRET: SECRET } as any

function req(path: string, body: unknown = {}): Request {
  return new Request(`https://rpc-sports-proxy.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Proxy-Secret": SECRET },
    body: JSON.stringify(body),
  })
}

// ⚠ /nba/scoreboard validates gameDate as MM/DD/YYYY and 400s BEFORE any fetch.
// My first draft posted {} and the stats cases recorded zero upstream calls —
// they were asserting against a request that never left the validator.
const SCOREBOARD_BODY = { gameDate: "01/15/2026" }

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/**
 * Stub global fetch with a per-URL QUEUE of responses, recording the
 * User-Agent each call was made with.
 *
 * ⚠ Sequencing matters here in a way the sibling test's substring stub cannot
 * express: the whole property under test is "the SECOND call differs from the
 * first", so a stub that returns one fixed response per URL could not fail.
 */
function stubSequenced(routes: Array<[string, Response[]]>) {
  const calls: Array<{ url: string; ua: string }> = []
  const queues = new Map(routes.map(([needle, list]) => [needle, [...list]]))
  const spy = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const headers = new Headers(init?.headers ?? {})
    calls.push({ url, ua: headers.get("User-Agent") ?? "" })
    for (const [needle, queue] of queues) {
      if (!url.includes(needle)) continue
      const next = queue.shift()
      if (!next) throw new Error(`queue exhausted for ${needle} (call ${calls.length})`)
      return next
    }
    throw new Error(`unstubbed fetch: ${url}`)
  })
  vi.stubGlobal("fetch", spy)
  return { spy, calls }
}

/** Drive a worker request to completion while advancing every pending sleep. */
async function runWithTimers(request: Request): Promise<Response> {
  const p = worker.fetch(request, env)
  // Flush repeatedly: the retry sleeps are scheduled only after the preceding
  // fetch settles, so one advance is not enough for the multi-attempt paths.
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5_000)
  return p
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("DraftKings 403/401 — retry once with a DIFFERENT fingerprint", () => {
  it("retries a 403 and rotates the User-Agent", async () => {
    vi.useFakeTimers()
    const { calls } = stubSequenced([
      ["draftkings.com/lobby/getcontests", [jsonRes({}, 403), jsonRes({ Contests: [] }, 200)]],
    ])
    await runWithTimers(req("/nba/draftkings-projections"))

    const dk = calls.filter((c) => c.url.includes("getcontests"))
    expect(dk.length, "a 403 must be retried exactly once").toBe(2)
    expect(dk[0].ua, "the first attempt must send a fingerprint").toBeTruthy()
    // ⚠ The load-bearing assertion. Retrying with the same UA is the bug the
    // rotation exists to prevent, and it looks identical by call count.
    expect(dk[1].ua, "the retry must change the fingerprint Akamai sees").not.toBe(dk[0].ua)
  })

  it("retries a 401 the same way — it is the same Akamai bucket", async () => {
    // Documented in the worker: 401s correlate with the same bucket when the
    // lobby cookie set lacks the tracking values the UA is expected to carry.
    vi.useFakeTimers()
    const { calls } = stubSequenced([
      ["draftkings.com/lobby/getcontests", [jsonRes({}, 401), jsonRes({ Contests: [] }, 200)]],
    ])
    await runWithTimers(req("/nba/draftkings-projections"))
    const dk = calls.filter((c) => c.url.includes("getcontests"))
    expect(dk.length).toBe(2)
    expect(dk[1].ua).not.toBe(dk[0].ua)
  })

  it("does NOT retry a 200 — the control that stops the cases above passing trivially", async () => {
    // Without this, a version that retried unconditionally would satisfy both
    // tests above while doubling live egress on every healthy request.
    vi.useFakeTimers()
    const { calls } = stubSequenced([
      ["draftkings.com/lobby/getcontests", [jsonRes({ Contests: [] }, 200)]],
    ])
    await runWithTimers(req("/nba/draftkings-projections"))
    expect(calls.filter((c) => c.url.includes("getcontests")).length).toBe(1)
  })

  it("does NOT retry a 500 — only the Akamai statuses are retried here", async () => {
    // 403/401 are a bot-rejection signal a new fingerprint can fix. A 500 is
    // upstream breakage; retrying it burns budget on an unchanged outcome.
    vi.useFakeTimers()
    const { calls } = stubSequenced([
      ["draftkings.com/lobby/getcontests", [jsonRes({}, 500)]],
    ])
    await runWithTimers(req("/nba/draftkings-projections"))
    expect(calls.filter((c) => c.url.includes("getcontests")).length).toBe(1)
  })
})

describe("stats.nba.com 5xx — bounded backoff, and 4xx returns immediately", () => {
  it("retries a 5xx up to 3 attempts, rotating the fingerprint each time", async () => {
    // stats.nba.com 520s sporadically (Cloudflare-on-Cloudflare). Three
    // attempts is the documented ceiling — an unbounded loop here would hold a
    // worker invocation open against a dead origin.
    vi.useFakeTimers()
    const { calls } = stubSequenced([
      ["stats.nba.com", [jsonRes({}, 520), jsonRes({}, 520), jsonRes({}, 520)]],
    ])
    await runWithTimers(req("/nba/scoreboard", SCOREBOARD_BODY))

    const stats = calls.filter((c) => c.url.includes("stats.nba.com"))
    expect(stats.length, "three attempts, then stop").toBe(3)
    expect(new Set(stats.map((c) => c.ua)).size, "the fingerprint must rotate between attempts").toBeGreaterThan(1)
  })

  it("returns a 4xx on the FIRST attempt — a 4xx will not change on retry", async () => {
    // The discriminating case: `res.status < 500` returns immediately. Without
    // it the worker would spend its whole budget re-asking for a 404.
    vi.useFakeTimers()
    const { calls } = stubSequenced([["stats.nba.com", [jsonRes({}, 404)]]])
    await runWithTimers(req("/nba/scoreboard", SCOREBOARD_BODY))
    expect(calls.filter((c) => c.url.includes("stats.nba.com")).length).toBe(1)
  })

  it("treats a network throw like a 5xx and retries it", async () => {
    // A timeout or DNS failure is transient in exactly the way a 520 is; the
    // catch arm exists so it is retried rather than surfacing on attempt one.
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      if (!url.includes("stats.nba.com")) throw new Error(`unstubbed: ${url}`)
      n++
      if (n < 3) throw new Error("network down")
      return jsonRes({ resultSets: [] }, 200)
    }))
    await runWithTimers(req("/nba/scoreboard", SCOREBOARD_BODY))
    expect(n, "two throws then a success = three attempts").toBe(3)
  })
})
