import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/odds-proxy/index.ts"

// Behavioural coverage for the odds-proxy Cloudflare Worker — fronts
// the-odds-api.com so the API key never leaves the worker secret store. It had
// ZERO tests. The load-bearing, previously-unguarded behaviours:
//   1. X-Proxy-Secret gate + the ODDS_API_KEY-missing 500 (never call upstream
//      with an undefined key).
//   2. The ALLOWED_PARAMS whitelist — callers must not be able to slip
//      arbitrary query fields through to the upstream; the worker injects apiKey
//      itself, and that key must never appear in a client-controllable param.
//   3. The upstream-failed 502 that redacts to an 800-char excerpt, and the
//      quota-header passthrough the pipeline reads from pipeline_runs.
// We call worker.fetch(request, env) directly with a stubbed global fetch.

let fetchMock: ReturnType<typeof vi.fn>
const env = { PROXY_SECRET: "s3cr3t", ODDS_API_KEY: "APIKEY123" }

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ODDS = "/v4/sports/basketball_nba/odds"
const SCORES = "/v4/sports/basketball_nba/scores"
const get = (path: string, secret?: string) =>
  new Request(`https://p.dev${path}`, { method: "GET", headers: secret ? { "X-Proxy-Secret": secret } : {} })

const upstream = () => new URL(String(fetchMock.mock.calls[0][0]))

describe("odds-proxy — gates", () => {
  it("answers CORS preflight 204", async () => {
    const res = await worker.fetch(new Request(`https://p.dev${ODDS}`, { method: "OPTIONS" }), env)
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET")
  })

  it("405s a non-GET method", async () => {
    const res = await worker.fetch(new Request(`https://p.dev${ODDS}`, { method: "POST" }), env)
    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a missing or wrong secret", async () => {
    expect((await worker.fetch(get(ODDS), env)).status).toBe(401)
    expect((await worker.fetch(get(ODDS, "nope"), env)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("500s when ODDS_API_KEY is not configured (never forwards an undefined key)", async () => {
    const res = await worker.fetch(get(ODDS, "s3cr3t"), { PROXY_SECRET: "s3cr3t" } as any)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("odds_api_key_missing")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("404s an unknown route", async () => {
    const res = await worker.fetch(get("/v4/sports/basketball_nba/props", "s3cr3t"), env)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("route_not_found")
  })
})

describe("odds-proxy — odds route param handling", () => {
  it("injects apiKey from the secret + applies default regions/markets/oddsFormat", async () => {
    await worker.fetch(get(ODDS, "s3cr3t"), env)
    const u = upstream()
    expect(u.origin + u.pathname).toBe("https://api.the-odds-api.com/v4/sports/basketball_nba/odds")
    expect(u.searchParams.get("apiKey")).toBe("APIKEY123")
    expect(u.searchParams.get("regions")).toBe("us")
    expect(u.searchParams.get("markets")).toBe("h2h,spreads,totals")
    expect(u.searchParams.get("oddsFormat")).toBe("american")
  })

  it("passes an allowlisted param through, overriding the default", async () => {
    await worker.fetch(get(`${ODDS}?regions=eu&bookmakers=draftkings`, "s3cr3t"), env)
    const u = upstream()
    expect(u.searchParams.get("regions")).toBe("eu")
    expect(u.searchParams.get("bookmakers")).toBe("draftkings")
  })

  it("DROPS a non-allowlisted param (cannot override the injected apiKey)", async () => {
    await worker.fetch(get(`${ODDS}?apiKey=ATTACKER&foo=bar`, "s3cr3t"), env)
    const u = upstream()
    expect(u.searchParams.get("apiKey")).toBe("APIKEY123") // injected key wins
    expect(u.searchParams.get("foo")).toBeNull() // arbitrary param dropped
  })

  it("surfaces the-odds-api quota headers on a successful passthrough + caches 5m", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("[{}]", {
        status: 200,
        headers: { "x-requests-remaining": "480", "x-requests-used": "20", "x-requests-last": "1" },
      }),
    )
    const res = await worker.fetch(get(ODDS, "s3cr3t"), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Quota-Remaining")).toBe("480")
    expect(res.headers.get("X-Quota-Used")).toBe("20")
    expect(res.headers.get("Cache-Control")).toContain("max-age=300")
  })

  it("502s an upstream failure with a redacted body excerpt + quota context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(2000), { status: 401, headers: { "x-requests-remaining": "0" } }),
    )
    const res = await worker.fetch(get(ODDS, "s3cr3t"), env)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("upstream_failed")
    expect(body.status).toBe(401)
    expect(body.body_excerpt.length).toBe(800) // capped, not the full 2000
    expect(body.quota_remaining).toBe("0")
  })
})

describe("odds-proxy — scores route", () => {
  it("injects apiKey, targets the scores path, defaults dateFormat, and caches 1m", async () => {
    const res = await worker.fetch(get(SCORES, "s3cr3t"), env)
    expect(res.status).toBe(200)
    const u = upstream()
    expect(u.origin + u.pathname).toBe("https://api.the-odds-api.com/v4/sports/basketball_nba/scores")
    expect(u.searchParams.get("apiKey")).toBe("APIKEY123")
    expect(u.searchParams.get("dateFormat")).toBe("iso")
    // No daysFrom default — omitting it keeps the call at 1 credit.
    expect(u.searchParams.get("daysFrom")).toBeNull()
    expect(res.headers.get("Cache-Control")).toContain("max-age=60")
  })

  it("passes allowlisted scores params through but DROPS non-allowlisted ones", async () => {
    await worker.fetch(get(`${SCORES}?daysFrom=3&eventIds=abc&apiKey=ATTACKER&markets=h2h`, "s3cr3t"), env)
    const u = upstream()
    expect(u.searchParams.get("daysFrom")).toBe("3")
    expect(u.searchParams.get("eventIds")).toBe("abc")
    expect(u.searchParams.get("apiKey")).toBe("APIKEY123") // injected key wins
    expect(u.searchParams.get("markets")).toBeNull() // odds-only param dropped
  })

  it("surfaces quota headers + 502s an upstream failure on the scores route", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope".repeat(500), { status: 429, headers: { "x-requests-remaining": "0" } }),
    )
    const res = await worker.fetch(get(SCORES, "s3cr3t"), env)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("upstream_failed")
    expect(body.status).toBe(429)
    expect(body.body_excerpt.length).toBe(800)
  })
})
