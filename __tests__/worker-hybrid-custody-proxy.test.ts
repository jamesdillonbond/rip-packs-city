import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/hybrid-custody-proxy/index.ts"

// Behavioural coverage for the hybrid-custody-proxy Cloudflare Worker — the
// Bearer-auth gate (a DIFFERENT rotation surface from topshot-proxy's
// X-Proxy-Secret) plus its defense-in-depth validation: the event-type
// allowlist, the Flow 250-block range cap, and the /head parse legs. Untested
// (workers are outside the coverage measure), so a regression that widened the
// allowlist, dropped the range cap (hammering Flow Access), or mis-parsed the
// sealed head was invisible. Calls worker.fetch(request, env) with stubbed fetch.

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const env = { PROXY_SECRET: "tok" }
const ALLOWED = "A.d8a7e05a7ac670c0.HybridCustody.OwnershipGranted"

const evReq = (body: unknown, auth = "Bearer tok") =>
  new Request("https://p.dev/events", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

describe("hybrid-custody-proxy — auth + routing", () => {
  it("204s an OPTIONS preflight without auth", async () => {
    const res = await worker.fetch(new Request("https://p.dev/events", { method: "OPTIONS" }), env)
    expect(res.status).toBe(204)
  })

  it("401s with no Authorization header", async () => {
    const res = await worker.fetch(new Request("https://p.dev/head", { method: "GET" }), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s with a wrong Bearer token", async () => {
    const res = await worker.fetch(evReq({ type: ALLOWED, start_height: 1, end_height: 2 }, "Bearer nope"), env)
    expect(res.status).toBe(401)
  })

  it("401s when the worker secret is unset (fail closed)", async () => {
    const res = await worker.fetch(evReq({ type: ALLOWED, start_height: 1, end_height: 2 }), { PROXY_SECRET: "" })
    expect(res.status).toBe(401)
  })

  it("404s an unknown route", async () => {
    const res = await worker.fetch(
      new Request("https://p.dev/nope", { method: "POST", headers: { Authorization: "Bearer tok" } }),
      env,
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("route_not_found")
  })
})

describe("hybrid-custody-proxy — /events validation", () => {
  it("400s on an invalid JSON body", async () => {
    const res = await worker.fetch(evReq("{not json"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json_body")
  })

  it("400s a non-allowlisted event type (defense in depth)", async () => {
    const res = await worker.fetch(evReq({ type: "A.foo.Bar.Baz", start_height: 1, end_height: 2 }), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("event_type_not_allowed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("400s an inverted or negative height range", async () => {
    expect((await worker.fetch(evReq({ type: ALLOWED, start_height: 10, end_height: 5 }), env)).status).toBe(400)
    expect((await worker.fetch(evReq({ type: ALLOWED, start_height: -1, end_height: 5 }), env)).status).toBe(400)
    expect((await worker.fetch(evReq({ type: ALLOWED, start_height: "x", end_height: 5 }), env)).status).toBe(400)
  })

  it("400s a range wider than the Flow 250-block cap", async () => {
    const res = await worker.fetch(evReq({ type: ALLOWED, start_height: 0, end_height: 250 }), env)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("range_too_large")
    expect(body.requested_span).toBe(250)
  })

  it("passes a valid range through to Flow /v1/events with the right params", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"events":[]}', { status: 200 }))
    const res = await worker.fetch(evReq({ type: ALLOWED, start_height: 100, end_height: 200 }), env)
    expect(res.status).toBe(200)
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.pathname).toBe("/v1/events")
    expect(url.searchParams.get("type")).toBe(ALLOWED)
    expect(url.searchParams.get("start_height")).toBe("100")
    expect(url.searchParams.get("end_height")).toBe("200")
  })

  it("allows a full 249-span (the boundary)", async () => {
    await worker.fetch(evReq({ type: ALLOWED, start_height: 0, end_height: 249 }), env)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe("hybrid-custody-proxy — /script + /head", () => {
  const scriptReq = (body: string) =>
    new Request("https://p.dev/script", { method: "POST", headers: { Authorization: "Bearer tok" }, body })
  const headReq = () =>
    new Request("https://p.dev/head", { method: "GET", headers: { Authorization: "Bearer tok" } })

  it("400s an empty script body", async () => {
    const res = await worker.fetch(scriptReq(""), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("empty_body")
  })

  it("passes a script body through to /v1/scripts", async () => {
    fetchMock.mockResolvedValueOnce(new Response("SCRIPT_RESULT", { status: 200 }))
    const res = await worker.fetch(scriptReq('{"script":"abc","arguments":[]}'), env)
    expect(res.status).toBe(200)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/scripts")
  })

  it("returns the sealed head height from /v1/blocks", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ header: { height: "123456789" } }]), { status: 200 }),
    )
    const res = await worker.fetch(headReq(), env)
    expect(res.status).toBe(200)
    expect((await res.json()).height).toBe(123456789)
  })

  it("502s when the head upstream is not ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 }))
    const res = await worker.fetch(headReq(), env)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("upstream_failed")
  })

  it("502s when the head body cannot be parsed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }))
    const res = await worker.fetch(headReq(), env)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("json_parse_failed")
  })

  it("502s when the head payload has no usable height", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ header: {} }]), { status: 200 }))
    const res = await worker.fetch(headReq(), env)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("head_height_missing")
  })
})
