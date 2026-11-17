import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/topshot-proxy/index.js"

// Behavioural coverage for the topshot-proxy Cloudflare Worker — the auth gate
// and route dispatch that every server-side Top Shot / All Day GQL read passes
// through. It had ZERO tests (workers are outside the vitest coverage measure),
// so a regression that dropped the X-Proxy-Secret check (opening an anonymous
// proxy to Dapper) or mis-routed /allday to the Top Shot upstream (silently
// wrong data) was invisible. We call worker.fetch(request, env) directly with a
// stubbed global fetch and assert the upstream URL + headers.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("UPSTREAM_OK", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const env = { PROXY_SECRET: "s3cr3t" }
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://proxy.example.dev${path}`, {
    method: "POST",
    headers: { "X-Proxy-Secret": "s3cr3t", ...headers },
    body: JSON.stringify({ query: "{ __typename }" }),
  })

const upstreamUrl = () => String(fetchMock.mock.calls[0][0])
const upstreamHeaders = () => fetchMock.mock.calls[0][1].headers as Record<string, string>

describe("topshot-proxy worker — gates", () => {
  it("answers CORS preflight with 204 + allow headers", async () => {
    const res = await worker.fetch(new Request("https://p.dev/topshot", { method: "OPTIONS" }), env)
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Proxy-Secret")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a non-POST, non-OPTIONS method", async () => {
    const res = await worker.fetch(new Request("https://p.dev/topshot", { method: "GET" }), env)
    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s when the proxy secret is missing", async () => {
    const req = new Request("https://p.dev/topshot", { method: "POST", body: "{}" })
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s when the proxy secret is wrong", async () => {
    const res = await worker.fetch(post("/topshot", { "X-Proxy-Secret": "nope" }), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("topshot-proxy worker — route dispatch", () => {
  it("routes /topshot to the Top Shot public-api endpoint", async () => {
    await worker.fetch(post("/topshot"), env)
    expect(upstreamUrl()).toBe("https://public-api.nbatopshot.com/graphql")
  })

  it("routes the bare / to the default Top Shot endpoint (back-compat)", async () => {
    await worker.fetch(post("/"), env)
    expect(upstreamUrl()).toBe("https://public-api.nbatopshot.com/graphql")
  })

  it("routes /allday to the All Day public-api endpoint", async () => {
    await worker.fetch(post("/allday"), env)
    expect(upstreamUrl()).toBe("https://public-api.nflallday.com/graphql")
  })

  it("accepts the legacy /all-day alias as /allday", async () => {
    await worker.fetch(post("/all-day"), env)
    expect(upstreamUrl()).toBe("https://public-api.nflallday.com/graphql")
  })

  it("routes /allday-consumer to the consumer graphql endpoint", async () => {
    await worker.fetch(post("/allday-consumer"), env)
    expect(upstreamUrl()).toBe("https://nflallday.com/consumer/graphql")
  })

  it("falls back to the default Top Shot route for an unknown path", async () => {
    await worker.fetch(post("/does-not-exist"), env)
    expect(upstreamUrl()).toBe("https://public-api.nbatopshot.com/graphql")
  })
})

describe("topshot-proxy worker — headers + passthrough", () => {
  it("sends the bare default UA on the plain topshot route (no browser spoof)", async () => {
    await worker.fetch(post("/topshot"), env)
    expect(upstreamHeaders()["User-Agent"]).toBe("sports-collectible-tool/0.1")
    expect(upstreamHeaders()["Origin"]).toBeUndefined()
  })

  it("adds the browser fingerprint headers on /allday-consumer", async () => {
    await worker.fetch(post("/allday-consumer"), env)
    const h = upstreamHeaders()
    expect(h["User-Agent"]).toContain("Mozilla/5.0")
    expect(h["Origin"]).toBe("https://nflallday.com")
    expect(h["Referer"]).toBe("https://nflallday.com/")
  })

  it("passes the upstream status + body straight back with CORS", async () => {
    fetchMock.mockResolvedValueOnce(new Response("GQL_BODY", { status: 418 }))
    const res = await worker.fetch(post("/topshot"), env)
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("GQL_BODY")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("forwards the request body to the upstream", async () => {
    await worker.fetch(post("/topshot"), env)
    expect(fetchMock.mock.calls[0][1].body).toContain("__typename")
  })
})
