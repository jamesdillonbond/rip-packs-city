import { describe, it, expect, afterEach, vi } from "vitest"
import worker from "@/workers/sports-proxy/index.ts"

// ── sports-proxy worker: fetch() ENTRY HANDLER coverage ─────────────────────
//
// The sibling __tests__/worker-sports-proxy-transforms.test.ts covers only the
// pure date/parse helpers in transforms.ts. The worker's actual request surface
// — the X-Proxy-Secret auth gate, CORS/method handling, the 4-route dispatch,
// and each handler's upstream orchestration (stats.nba.com / DraftKings /
// cdn.nba.com passthroughs) — lived entirely untested (worker coverage measured
// ~18% before this file). A dropped auth check here is an OPEN sports-data relay
// on our paid Cloudflare egress; a mis-route silently 404s a live pipeline.
//
// Pattern mirrors worker-topshot-proxy-routing / worker-hybrid-custody-proxy:
// invoke worker.fetch(request, env) with a stubbed global fetch so the upstream
// calls are deterministic and no real network / retry timers fire.

const SECRET = "test-proxy-secret"

/** Build a POST request to a proxy route with the correct secret by default. */
function req(
  path: string,
  opts: { secret?: string | null; method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const secret = opts.secret === undefined ? SECRET : opts.secret
  if (secret !== null) headers["X-Proxy-Secret"] = secret
  const method = opts.method ?? "POST"
  const canHaveBody = method !== "GET" && method !== "HEAD"
  return new Request(`https://rpc-sports-proxy.example${path}`, {
    method,
    headers,
    body: canHaveBody ? (opts.body === undefined ? "{}" : JSON.stringify(opts.body)) : undefined,
  })
}

const env = { PROXY_SECRET: SECRET } as any

/**
 * Route the stubbed global fetch by URL substring. `routes` maps a substring to
 * a Response factory; the first match wins. Unmatched URLs throw so a test can't
 * silently pass on an un-stubbed upstream.
 */
function stubFetch(routes: Array<[string, () => Response]>) {
  const spy = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url
    for (const [needle, make] of routes) {
      if (url.includes(needle)) return make()
    }
    throw new Error(`unstubbed fetch: ${url}`)
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("sports-proxy worker — entry gate", () => {
  it("answers an OPTIONS preflight with 204 + CORS headers and no auth", async () => {
    const res = await worker.fetch(req("/nba/scoreboard", { method: "OPTIONS", secret: null }), env)
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Proxy-Secret")
  })

  it("405s a non-POST, non-OPTIONS method (before auth)", async () => {
    const res = await worker.fetch(req("/nba/scoreboard", { method: "GET" }), env)
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: "method_not_allowed" })
  })

  it("401s when the proxy secret header is missing", async () => {
    const res = await worker.fetch(req("/nba/scoreboard", { secret: null }), env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  it("401s when the proxy secret is wrong", async () => {
    const res = await worker.fetch(req("/nba/scoreboard", { secret: "nope" }), env)
    expect(res.status).toBe(401)
  })

  it("401s when the worker secret is unset (fail closed)", async () => {
    const res = await worker.fetch(req("/nba/scoreboard"), { PROXY_SECRET: undefined } as any)
    expect(res.status).toBe(401)
  })

  it("404s an unknown route (authenticated) and echoes the path", async () => {
    const res = await worker.fetch(req("/nba/unknown"), env)
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error).toBe("route_not_found")
    expect(body.path).toBe("/nba/unknown")
  })

  it("normalizes a trailing slash and is case-insensitive on the path", async () => {
    const res = await worker.fetch(req("/NBA/Odds/"), env)
    // /nba/odds -> handleOdds -> 501 placeholder (proves the normalize+dispatch)
    expect(res.status).toBe(501)
    expect((await res.json()) as any).toEqual({ error: "odds_route_pending_api_key" })
  })
})

describe("sports-proxy worker — /nba/scoreboard", () => {
  it("400s an invalid JSON body", async () => {
    const bad = new Request("https://x.example/nba/scoreboard", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Proxy-Secret": SECRET },
      body: "{ not json",
    })
    const res = await worker.fetch(bad, env)
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: "invalid_json_body" })
  })

  it("400s a missing / malformed gameDate", async () => {
    const res = await worker.fetch(req("/nba/scoreboard", { body: { gameDate: "2026-01-01" } }), env)
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: "gameDate_required_mmddyyyy" })
  })

  it("passes upstream JSON through with a 200 + cache header on success", async () => {
    stubFetch([["stats.nba.com", () => new Response('{"ok":true}', { status: 200 })]])
    const res = await worker.fetch(req("/nba/scoreboard", { body: { gameDate: "01/15/2026" } }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("max-age=300")
    expect(await res.text()).toBe('{"ok":true}')
  })

  it("502s when the stats upstream is not ok", async () => {
    // 404 is <500 so fetchWithStatsRetry returns immediately (no retry timers).
    stubFetch([["stats.nba.com", () => new Response("blocked", { status: 404 })]])
    const res = await worker.fetch(req("/nba/scoreboard", { body: { gameDate: "01/15/2026" } }), env)
    expect(res.status).toBe(502)
    const body = (await res.json()) as any
    expect(body.error).toBe("upstream_failed")
    expect(body.status).toBe(404)
  })
})

describe("sports-proxy worker — /nba/draftkings-projections", () => {
  it("returns no_nba_slate_today (200) when the lobby lists no matching contest", async () => {
    stubFetch([["draftkings.com/lobby", () => jsonRes({ Contests: [] })]])
    const res = await worker.fetch(req("/nba/draftkings-projections"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.note).toBe("no_nba_slate_today")
    expect(body.draftGroupId).toBeNull()
    expect(body.players).toEqual([])
  })

  it("502s when the draftgroups lobby upstream is not ok", async () => {
    // 500 (not 401/403) returns immediately from fetchWithDkRetry.
    stubFetch([["draftkings.com/lobby", () => new Response("err", { status: 500 })]])
    const res = await worker.fetch(req("/nba/draftkings-projections"), env)
    expect(res.status).toBe(502)
    expect((await res.json()) as any).toMatchObject({ error: "draftgroups_upstream_failed", status: 500 })
  })

  it("502s draftgroups_not_json when the lobby body is not JSON", async () => {
    stubFetch([["draftkings.com/lobby", () => new Response("<html>", { status: 200 })]])
    const res = await worker.fetch(req("/nba/draftkings-projections"), env)
    expect(res.status).toBe(502)
    expect((await res.json()) as any).toMatchObject({ error: "draftgroups_not_json" })
  })
})

describe("sports-proxy worker — /nba/rolling-projections", () => {
  it("returns no_nba_slate_today (200) when the cdn scoreboard has zero games", async () => {
    stubFetch([
      ["cdn.nba.com", () => jsonRes({ scoreboard: { gameDate: "2026-01-15", games: [] } })],
      ["stats.nba.com", () => jsonRes({ resultSets: [] })],
    ])
    const res = await worker.fetch(req("/nba/rolling-projections"), env)
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ note: "no_nba_slate_today", games: [] })
  })

  it("502s when the cdn scoreboard upstream is not ok", async () => {
    stubFetch([
      ["cdn.nba.com", () => new Response("boom", { status: 503 })],
      ["stats.nba.com", () => jsonRes({ resultSets: [] })],
    ])
    const res = await worker.fetch(req("/nba/rolling-projections"), env)
    expect(res.status).toBe(502)
    expect((await res.json()) as any).toMatchObject({ error: "scoreboard_upstream_failed", status: 503 })
  })

  it("ships games + parsed players (200) when both upstreams succeed", async () => {
    const scoreboard = {
      scoreboard: {
        gameDate: "2026-01-15",
        games: [
          {
            gameId: "0022600001",
            gameTimeUTC: "2026-01-16T00:00:00Z",
            homeTeam: { teamId: 1610612747, teamTricode: "LAL" },
            awayTeam: { teamId: 1610612744, teamTricode: "GSW" },
          },
        ],
      },
    }
    const playerStats = {
      resultSets: [
        {
          name: "LeagueDashPlayerStats",
          headers: ["PLAYER_NAME", "TEAM_ABBREVIATION", "GP", "MIN", "PTS", "REB", "AST", "TOV", "STL", "BLK", "FG3M", "DD2", "TD3"],
          rowSet: [["LeBron James", "LAL", 10, 35, 25, 8, 8, 3, 1, 1, 2, 3, 0]],
        },
      ],
    }
    stubFetch([
      ["cdn.nba.com", () => jsonRes(scoreboard)],
      ["stats.nba.com", () => jsonRes(playerStats)],
    ])
    const res = await worker.fetch(req("/nba/rolling-projections"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.source).toBe("nba-stats-rolling5")
    expect(body.games).toHaveLength(1)
    expect(body.games[0]).toMatchObject({ homeAbbr: "LAL", awayAbbr: "GSW", name: "GSW @ LAL" })
    expect(body.players).toHaveLength(1)
    expect(body.players[0].name).toBe("LeBron James")
    // projFp computed from the DK formula; opponent attached from the game.
    expect(typeof body.players[0].projFp).toBe("number")
    expect(body.players[0].opponentAbbr).toBe("GSW")
  })

  it("ships games-only with a degradation note when player-stats is blocked", async () => {
    const scoreboard = {
      scoreboard: {
        gameDate: "2026-01-15",
        games: [
          {
            gameId: "0022600002",
            gameTimeUTC: "2026-01-16T00:00:00Z",
            homeTeam: { teamTricode: "BOS" },
            awayTeam: { teamTricode: "MIA" },
          },
        ],
      },
    }
    // 403 is <500 so fetchWithStatsRetry returns immediately (no backoff timers).
    stubFetch([
      ["cdn.nba.com", () => jsonRes(scoreboard)],
      ["stats.nba.com", () => new Response("blocked", { status: 403 })],
    ])
    const res = await worker.fetch(req("/nba/rolling-projections"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.games).toHaveLength(1)
    expect(body.players).toEqual([])
    expect(body.note).toContain("playerstats_upstream_blocked")
    expect(body.upstreamPlayerStatusOnDegrade).toBe(403)
  })
})

describe("sports-proxy worker — /nba/odds", () => {
  it("501s as a pending placeholder when ODDS_API_KEY is unset", async () => {
    const res = await worker.fetch(req("/nba/odds"), env)
    expect(res.status).toBe(501)
    expect((await res.json()) as any).toEqual({ error: "odds_route_pending_api_key" })
  })

  const oddsEnv = { PROXY_SECRET: SECRET, ODDS_API_KEY: "odds-key-123" } as any

  it("relays to the-odds-api with the key + defaults injected on success", async () => {
    const spy = stubFetch([
      ["the-odds-api.com", () => new Response('[{"id":"g1"}]', { status: 200 })],
    ])
    const res = await worker.fetch(req("/nba/odds", { body: {} }), oddsEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("max-age=300")
    expect(await res.text()).toBe('[{"id":"g1"}]')

    // Key is injected and the caller-facing defaults are applied.
    const calledUrl = spy.mock.calls[0][0] as string
    const u = new URL(calledUrl)
    expect(u.searchParams.get("apiKey")).toBe("odds-key-123")
    expect(u.searchParams.get("regions")).toBe("us")
    expect(u.searchParams.get("markets")).toBe("h2h,spreads,totals")
    expect(u.searchParams.get("oddsFormat")).toBe("american")
  })

  it("forwards whitelisted body params and ignores unknown ones", async () => {
    const spy = stubFetch([
      ["the-odds-api.com", () => new Response("[]", { status: 200 })],
    ])
    const res = await worker.fetch(
      req("/nba/odds", { body: { regions: "us,uk", bookmakers: "draftkings", nefarious: "1" } }),
      oddsEnv,
    )
    expect(res.status).toBe(200)
    const u = new URL(spy.mock.calls[0][0] as string)
    expect(u.searchParams.get("regions")).toBe("us,uk") // whitelisted override
    expect(u.searchParams.get("bookmakers")).toBe("draftkings")
    expect(u.searchParams.has("nefarious")).toBe(false) // not whitelisted
  })

  it("surfaces the-odds-api quota headers on a successful relay", async () => {
    stubFetch([
      [
        "the-odds-api.com",
        () =>
          new Response("[]", {
            status: 200,
            headers: {
              "x-requests-remaining": "487",
              "x-requests-used": "13",
              "x-requests-last": "1",
            },
          }),
      ],
    ])
    const res = await worker.fetch(req("/nba/odds", { body: {} }), oddsEnv)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Quota-Remaining")).toBe("487")
    expect(res.headers.get("X-Quota-Used")).toBe("13")
    expect(res.headers.get("X-Quota-Last")).toBe("1")
  })

  it("502s when the-odds-api upstream is not ok", async () => {
    stubFetch([
      ["the-odds-api.com", () => new Response("quota exceeded", { status: 429 })],
    ])
    const res = await worker.fetch(req("/nba/odds", { body: {} }), oddsEnv)
    expect(res.status).toBe(502)
    const body = (await res.json()) as any
    expect(body.error).toBe("upstream_failed")
    expect(body.status).toBe(429)
  })
})
