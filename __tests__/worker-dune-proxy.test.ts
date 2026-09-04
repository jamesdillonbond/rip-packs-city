import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/dune-proxy/index.ts"

// Behavioural coverage for the dune-proxy Cloudflare Worker — the 4th auth
// rotation surface (DUNE_PROXY_SECRET) that holds the Dune API key so it never
// reaches Vercel logs. Untested (workers are outside the coverage measure).
// The security-critical property is the /execute body ALLOWLIST: only
// query_parameters + performance are forwarded upstream, never arbitrary caller
// JSON. Also pins the key injection, query_id/execution_id validation, the
// limit clamp, and the api-key-unset 500. Calls worker.fetch with stubbed fetch.

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const env = { DUNE_PROXY_SECRET: "tok", DUNE_API_KEY: "dune-key" }
const authed = (path: string, init: RequestInit = {}) =>
  new Request(`https://p.dev${path}`, {
    ...init,
    headers: { Authorization: "Bearer tok", ...(init.headers as any) },
  })
const upstreamUrl = () => new URL(String(fetchMock.mock.calls[0][0]))
const upstreamInit = () => fetchMock.mock.calls[0][1] as RequestInit

describe("dune-proxy — gates", () => {
  it("serves /health without auth and without an upstream call", async () => {
    const res = await worker.fetch(new Request("https://p.dev/health"), env)
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a results call with no Bearer", async () => {
    const res = await worker.fetch(new Request("https://p.dev/results?query_id=1"), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s a wrong Bearer", async () => {
    const res = await worker.fetch(authed("/results?query_id=1", { headers: { Authorization: "Bearer nope" } }), env)
    expect(res.status).toBe(401)
  })

  it("404s an unknown authed route", async () => {
    const res = await worker.fetch(authed("/nope"), env)
    expect(res.status).toBe(404)
  })

  it("500s when the Dune API key is unset", async () => {
    const res = await worker.fetch(authed("/results?query_id=1"), { DUNE_PROXY_SECRET: "tok", DUNE_API_KEY: "" })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("dune_api_key_unset")
  })
})

describe("dune-proxy — /results", () => {
  it("400s a non-numeric query_id", async () => {
    const res = await worker.fetch(authed("/results?query_id=abc"), env)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("injects the Dune API key and builds the results URL with limit/offset", async () => {
    await worker.fetch(authed("/results?query_id=8030177&limit=250&offset=500"), env)
    const url = upstreamUrl()
    expect(url.pathname).toBe("/api/v1/query/8030177/results")
    expect(url.searchParams.get("limit")).toBe("250")
    expect(url.searchParams.get("offset")).toBe("500")
    expect((upstreamInit().headers as any)["X-Dune-API-Key"]).toBe("dune-key")
  })

  it("clamps limit to the 1000-row Dune page cap and floors a bad offset to 0", async () => {
    await worker.fetch(authed("/results?query_id=1&limit=99999&offset=-5"), env)
    const url = upstreamUrl()
    expect(url.searchParams.get("limit")).toBe("1000")
    expect(url.searchParams.get("offset")).toBe("0")
  })

  it("falls back to the default page size on a non-numeric limit (no limit=NaN upstream)", async () => {
    await worker.fetch(authed("/results?query_id=1&limit=foo"), env)
    // Before the guard this forwarded limit=NaN, which Dune rejects with a 400.
    expect(upstreamUrl().searchParams.get("limit")).toBe("1000")
  })
})

describe("dune-proxy — /execute body allowlist (security)", () => {
  it("400s a non-numeric query_id", async () => {
    const res = await worker.fetch(authed("/execute?query_id=x", { method: "POST" }), env)
    expect(res.status).toBe(400)
  })

  it("forwards ONLY query_parameters + performance, dropping arbitrary caller fields", async () => {
    await worker.fetch(
      authed("/execute?query_id=42", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query_parameters: { set_ids: "230,253" },
          performance: "large",
          evil: "DROP TABLE",
          extra: { nested: true },
        }),
      }),
      env,
    )
    const sent = JSON.parse(String(upstreamInit().body))
    expect(sent).toEqual({ query_parameters: { set_ids: "230,253" }, performance: "large" })
    expect(sent.evil).toBeUndefined()
    expect(sent.extra).toBeUndefined()
  })

  it("runs with saved defaults (no body) for a body-less execute", async () => {
    await worker.fetch(authed("/execute?query_id=42", { method: "POST" }), env)
    expect(upstreamInit().body).toBeUndefined()
    // no Content-Type header when no body is forwarded
    expect((upstreamInit().headers as any)["Content-Type"]).toBeUndefined()
  })

  it("ignores a malformed body and runs with saved defaults", async () => {
    await worker.fetch(authed("/execute?query_id=42", { method: "POST", body: "{not json" }), env)
    expect(upstreamInit().body).toBeUndefined()
  })

  it("sends no body when the caller supplies only disallowed fields", async () => {
    await worker.fetch(
      authed("/execute?query_id=42", { method: "POST", body: JSON.stringify({ evil: 1 }) }),
      env,
    )
    expect(upstreamInit().body).toBeUndefined()
  })
})

describe("dune-proxy — /status", () => {
  it("400s a missing/invalid execution_id", async () => {
    expect((await worker.fetch(authed("/status"), env)).status).toBe(400)
    expect((await worker.fetch(authed("/status?execution_id=has spaces"), env)).status).toBe(400)
  })

  it("builds the status URL for a valid execution_id", async () => {
    await worker.fetch(authed("/status?execution_id=01ABC_xyz-99"), env)
    expect(upstreamUrl().pathname).toBe("/api/v1/execution/01ABC_xyz-99/status")
    expect((upstreamInit().headers as any)["X-Dune-API-Key"]).toBe("dune-key")
  })
})
