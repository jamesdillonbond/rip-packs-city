import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import baseWorker from "@/workers/base-proxy/index.js"
import flowevmWorker from "@/workers/flowevm-proxy/index.js"
import heliusWorker from "@/workers/helius-proxy/index.js"

// Behavioural coverage for the three RPC-passthrough Cloudflare Workers
// (base-proxy, flowevm-proxy, helius-proxy). They are near-identical: a GET
// health probe, a POST that gates on X-Proxy-Secret and forwards the raw body
// to a fixed upstream RPC. They had ZERO tests (workers are outside the vitest
// coverage measure), so a regression that dropped the secret check — turning
// any of them into an anonymous, paid-egress open RPC relay — was invisible.
// helius-proxy additionally reads its keyed upstream from a secret
// (HELIUS_RPC_URL), so a missing-config regression must fail 500, not silently
// forward to the wrong host. We call worker.fetch(request, env) directly with a
// stubbed global fetch and assert the upstream URL + auth behaviour.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"result":"UPSTREAM_OK"}', { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const upstreamUrl = () => String(fetchMock.mock.calls[0][0])

const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" })
const post = (secret?: string) =>
  new Request("https://proxy.example.dev/", {
    method: "POST",
    headers: secret ? { "X-Proxy-Secret": secret } : {},
    body: rpcBody,
  })

// base-proxy / flowevm-proxy share the exact same shape and PROXY_SECRET env.
const simple = [
  { name: "base-proxy", worker: baseWorker, upstream: "https://mainnet.base.org", ok: "base-proxy ok" },
  { name: "flowevm-proxy", worker: flowevmWorker, upstream: "https://mainnet.evm.nodes.onflow.org", ok: "flowevm-proxy ok" },
] as const

describe.each(simple)("$name — passthrough RPC proxy", ({ worker, upstream, ok }) => {
  const env = { PROXY_SECRET: "s3cr3t" }

  it("answers a GET health probe 200 without touching upstream", async () => {
    const res = await worker.fetch(new Request("https://p.dev/", { method: "GET" }), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(ok)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a non-POST, non-GET method", async () => {
    const res = await worker.fetch(new Request("https://p.dev/", { method: "PUT" }), env)
    expect(res.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a POST with no proxy secret", async () => {
    const res = await worker.fetch(post(), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a POST with the wrong proxy secret", async () => {
    const res = await worker.fetch(post("nope"), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("forwards an authed POST body verbatim to the fixed upstream + returns it with CORS", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"result":"chain"}', { status: 200 }))
    const res = await worker.fetch(post("s3cr3t"), env)
    expect(upstreamUrl()).toBe(upstream)
    expect(fetchMock.mock.calls[0][1].method).toBe("POST")
    expect(fetchMock.mock.calls[0][1].body).toBe(rpcBody)
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(await res.text()).toBe('{"result":"chain"}')
  })

  it("passes the upstream status straight through (does not mask a 500)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    const res = await worker.fetch(post("s3cr3t"), env)
    expect(res.status).toBe(500)
  })
})

describe("helius-proxy — keyed Solana DAS passthrough", () => {
  const env = { HELIUS_PROXY_SECRET: "h3lius", HELIUS_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=SECRET" }

  it("answers a GET health probe 200 without touching upstream", async () => {
    const res = await heliusWorker.fetch(new Request("https://p.dev/", { method: "GET" }), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("helius-proxy ok")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a non-POST, non-GET method", async () => {
    const res = await heliusWorker.fetch(new Request("https://p.dev/", { method: "DELETE" }), env)
    expect(res.status).toBe(405)
  })

  it("401s when the HELIUS_PROXY_SECRET header is missing or wrong", async () => {
    expect((await heliusWorker.fetch(post(), env)).status).toBe(401)
    expect((await heliusWorker.fetch(post("nope"), env)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses HELIUS_PROXY_SECRET, NOT the shared PROXY_SECRET (independent auth surface)", async () => {
    // A request bearing the shared TS_PROXY_SECRET value must NOT authorize here.
    const res = await heliusWorker.fetch(post("s3cr3t"), { ...env, PROXY_SECRET: "s3cr3t" })
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("500s when HELIUS_RPC_URL is not configured (never forwards to a wrong host)", async () => {
    const res = await heliusWorker.fetch(post("h3lius"), { HELIUS_PROXY_SECRET: "h3lius" })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain("HELIUS_RPC_URL")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("forwards an authed POST to the keyed upstream from the secret, body verbatim", async () => {
    const dasBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetsByOwner", params: { ownerAddress: "abc" } })
    const req = new Request("https://p.dev/", { method: "POST", headers: { "X-Proxy-Secret": "h3lius" }, body: dasBody })
    fetchMock.mockResolvedValueOnce(new Response('{"result":{"items":[]}}', { status: 200 }))
    const res = await heliusWorker.fetch(req, env)
    expect(upstreamUrl()).toBe(env.HELIUS_RPC_URL)
    expect(fetchMock.mock.calls[0][1].body).toBe(dasBody)
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("passes the upstream status through on a rate-limit (429)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
    const res = await heliusWorker.fetch(post("h3lius"), env)
    expect(res.status).toBe(429)
  })
})
