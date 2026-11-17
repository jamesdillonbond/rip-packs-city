import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/pinnacle-proxy/index.js"

// Behavioural coverage for the pinnacle-proxy Cloudflare Worker — the Disney
// Pinnacle GQL passthrough AND the paid-egress /render/<rid> asset amplifier.
// It had ZERO tests. The two things that MUST hold and were unguarded:
//   1. Both routes gate on X-Proxy-Secret == env.PROXY_SECRET. A dropped check
//      on /render turns it into an anonymous, paid-egress relay to the studio
//      asset CDN.
//   2. /render validates render_id against a strict slug regex (SSRF guard);
//      an unknown/invalid id must 404/400, never proxy an attacker-chosen URL.
// We call worker.fetch(request, env) directly with a stubbed global fetch and
// script the two upstreams (studio GQL → signed URL, then the asset bytes).

let fetchMock: ReturnType<typeof vi.fn>
const env = { PROXY_SECRET: "s3cr3t" }

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("UPSTREAM", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const gqlPost = (secret?: string) =>
  new Request("https://p.dev/graphql", {
    method: "POST",
    headers: secret ? { "X-Proxy-Secret": secret } : {},
    body: JSON.stringify({ query: "{ __typename }" }),
  })

const renderGet = (rid: string, secret?: string, query = "") =>
  new Request(`https://p.dev/render/${rid}${query}`, {
    method: "GET",
    headers: secret ? { "X-Proxy-Secret": secret } : {},
  })

// A studio-GQL fixture that returns the given medias array for the edition.
const gqlMediasResponse = (medias: Array<{ name: string; url: string }>) =>
  new Response(
    JSON.stringify({ data: { searchPinnacleEditions: { edges: [{ node: { render_id: "X", medias } }] } } }),
    { status: 200 },
  )

describe("pinnacle-proxy — GQL passthrough gates", () => {
  it("answers CORS preflight 204 with the X-Proxy-Secret allow header", async () => {
    const res = await worker.fetch(new Request("https://p.dev/graphql", { method: "OPTIONS" }), env)
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Proxy-Secret")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a non-POST to /graphql", async () => {
    const res = await worker.fetch(new Request("https://p.dev/graphql", { method: "PUT" }), env)
    expect(res.status).toBe(405)
  })

  it("401s a POST with a missing or wrong secret", async () => {
    expect((await worker.fetch(gqlPost(), env)).status).toBe(401)
    expect((await worker.fetch(gqlPost("nope"), env)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("forwards an authed POST to the Disney Pinnacle GQL endpoint with CORS", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"data":{}}', { status: 200 }))
    const res = await worker.fetch(gqlPost("s3cr3t"), env)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://public-api.disneypinnacle.com/graphql")
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("passes the upstream status through (does not mask a GQL 500)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 500 }))
    const res = await worker.fetch(gqlPost("s3cr3t"), env)
    expect(res.status).toBe(500)
  })
})

describe("pinnacle-proxy — /render asset amplifier", () => {
  it("401s a render request with no/ wrong secret (paid-egress gate)", async () => {
    expect((await worker.fetch(renderGet("LEV2-LION-CARE-S6"), env)).status).toBe(401)
    expect((await worker.fetch(renderGet("LEV2-LION-CARE-S6", "nope"), env)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("400s an invalid render_id (SSRF slug guard) without any upstream call", async () => {
    // '..' / slashes / over-length all fail the strict [A-Za-z0-9-]{3,64} regex.
    const res = await worker.fetch(renderGet("..%2Fetc%2Fpasswd", "s3cr3t"), env)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves a signed URL then streams the asset bytes back as image/png", async () => {
    fetchMock
      .mockResolvedValueOnce(gqlMediasResponse([{ name: "Front_Transparent", url: "https://assets.dp.com/signed.png" }]))
      .mockResolvedValueOnce(new Response("PNGBYTES", { status: 200, headers: { "Content-Type": "image/png" } }))
    const res = await worker.fetch(renderGet("LEV2-LION-CARE-S6", "s3cr3t"), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=")
    // First upstream is the studio GQL, second is the signed asset URL it returned.
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.production.studio-platform.dapperlabs.com/graphql")
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://assets.dp.com/signed.png")
  })

  it("honours ?v=quarter by preferring the Front_Quarter_Transparent media", async () => {
    fetchMock
      .mockResolvedValueOnce(
        gqlMediasResponse([
          { name: "Front_Transparent", url: "https://assets.dp.com/front.png" },
          { name: "Front_Quarter_Transparent", url: "https://assets.dp.com/quarter.png" },
        ]),
      )
      .mockResolvedValueOnce(new Response("PNGBYTES", { status: 200, headers: { "Content-Type": "image/png" } }))
    await worker.fetch(renderGet("LEV2-LION-CARE-S6", "s3cr3t", "?v=quarter"), env)
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://assets.dp.com/quarter.png")
  })

  it("404s an unknown render_id (studio GQL returns no medias)", async () => {
    fetchMock.mockResolvedValueOnce(gqlMediasResponse([]))
    const res = await worker.fetch(renderGet("UNKNOWN-RID", "s3cr3t"), env)
    expect(res.status).toBe(404)
  })

  it("404s when the studio GQL itself errors (non-ok) rather than proxying garbage", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gql down", { status: 502 }))
    const res = await worker.fetch(renderGet("LEV2-LION-CARE-S6", "s3cr3t"), env)
    expect(res.status).toBe(404)
  })

  it("surfaces the real upstream status when the signed asset fetch is CDN-blocked (403)", async () => {
    fetchMock
      .mockResolvedValueOnce(gqlMediasResponse([{ name: "Front_Transparent", url: "https://assets.dp.com/signed.png" }]))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
    const res = await worker.fetch(renderGet("LEV2-LION-CARE-S6", "s3cr3t"), env)
    // 403 here = CF Workers egress is ALSO CDN-blocked; the worker surfaces it.
    expect(res.status).toBe(403)
  })

  it("502s when the asset fetch throws", async () => {
    fetchMock
      .mockResolvedValueOnce(gqlMediasResponse([{ name: "Front_Transparent", url: "https://assets.dp.com/signed.png" }]))
      .mockRejectedValueOnce(new Error("network"))
    const res = await worker.fetch(renderGet("LEV2-LION-CARE-S6", "s3cr3t"), env)
    expect(res.status).toBe(502)
  })
})
