import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/reddit-proxy/index.js"

// Behavioural coverage for the reddit-proxy Cloudflare Worker — fronts
// reddit.com listing endpoints for the announcements ingest. It had ZERO tests.
// The load-bearing, previously-unguarded behaviours:
//   1. X-Proxy-Secret gate (a dropped check = anonymous relay).
//   2. The ALLOWED_PREFIXES allowlist — the ONLY thing stopping this from being
//      a generic open relay to any reddit.com path (SSRF surface). Anything off
//      the allowlist must 404 without an upstream call.
//   3. Cache HIT/MISS via Cloudflare `caches.default` (stubbed here) and a
//      contact-aware User-Agent (Reddit hard-blocks null/empty UAs).
// We call worker.fetch(request, env, ctx) directly with a stubbed global fetch,
// a stubbed `caches`, and a ctx whose waitUntil we can assert.

let fetchMock: ReturnType<typeof vi.fn>
let cacheStore: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
let ctx: { waitUntil: ReturnType<typeof vi.fn> }
const env = { PROXY_SECRET: "s3cr3t" }

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"data":{"children":[]}}', { status: 200, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetchMock)
  cacheStore = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) }
  vi.stubGlobal("caches", { default: cacheStore })
  ctx = { waitUntil: vi.fn() }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const get = (path: string, secret?: string) =>
  new Request(`https://p.dev${path}`, { method: "GET", headers: secret ? { "X-Proxy-Secret": secret } : {} })

describe("reddit-proxy — gates", () => {
  it("answers CORS preflight 204", async () => {
    const res = await worker.fetch(new Request("https://p.dev/r/x/new.json", { method: "OPTIONS" }), env, ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET")
  })

  it("405s a non-GET method (reddit listing endpoints are GET-only)", async () => {
    const res = await worker.fetch(new Request("https://p.dev/r/x/new.json", { method: "POST" }), env, ctx)
    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a missing or wrong secret", async () => {
    expect((await worker.fetch(get("/r/x/new.json"), env, ctx)).status).toBe(401)
    expect((await worker.fetch(get("/r/x/new.json", "nope"), env, ctx)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("reddit-proxy — allowlist (SSRF guard)", () => {
  it("404s a path off the allowlist without hitting upstream", async () => {
    const res = await worker.fetch(get("/user/spez/about.json", "s3cr3t"), env, ctx)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("path_not_allowed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("404s an attempt to reach an arbitrary reddit path", async () => {
    const res = await worker.fetch(get("/r/x/../../admin.json", "s3cr3t"), env, ctx)
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    "/r/nba/new.json",
    "/r/nba/hot.json",
    "/r/nba/top.json",
    "/r/nba/rising.json",
    "/comments/abc123.json",
  ])("allows %s and forwards to www.reddit.com verbatim", async (path) => {
    await worker.fetch(get(path, "s3cr3t"), env, ctx)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://www.reddit.com${path}`)
  })
})

describe("reddit-proxy — fetch + cache", () => {
  it("forwards query params and sends the contact-aware User-Agent", async () => {
    await worker.fetch(get("/r/nba/new.json?limit=25", "s3cr3t"), env, ctx)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://www.reddit.com/r/nba/new.json?limit=25")
    const ua = fetchMock.mock.calls[0][1].headers["User-Agent"]
    expect(ua).toContain("rip-packs-city")
    expect(ua.length).toBeGreaterThan(0)
  })

  it("returns X-Cache: MISS and caches a successful response via ctx.waitUntil", async () => {
    const res = await worker.fetch(get("/r/nba/new.json", "s3cr3t"), env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Cache")).toBe("MISS")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60")
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1)
    expect(cacheStore.put).toHaveBeenCalled()
  })

  it("does NOT cache a non-ok upstream response (no-store, no cache.put)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("429", { status: 429 }))
    const res = await worker.fetch(get("/r/nba/new.json", "s3cr3t"), env, ctx)
    expect(res.status).toBe(429)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    // The error response used to advertise `public, max-age=60`; it must not.
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("serves a cache HIT without a new upstream fetch", async () => {
    cacheStore.match.mockResolvedValueOnce(new Response('{"cached":true}', { status: 200 }))
    const res = await worker.fetch(get("/r/nba/new.json", "s3cr3t"), env, ctx)
    expect(res.headers.get("X-Cache")).toBe("HIT")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("502s when the upstream fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("reset"))
    const res = await worker.fetch(get("/r/nba/new.json", "s3cr3t"), env, ctx)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("upstream_fetch_failed")
  })
})
