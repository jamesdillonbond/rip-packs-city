import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
// @ts-expect-error — plain worker module imported by explicit .ts path
import worker from "@/workers/spork-proxy/index.ts"

// Behavioural coverage for the spork-proxy Cloudflare Worker — historical Flow
// spork access (its own SPORK_PROXY_SECRET surface). Untested. The load-bearing
// logic is the SPORK SELECTION: a height range must fall inside a single spork
// (pickSpork returns null across a boundary → 400) and anything at/above the
// current-spork floor is rejected (use public REST instead) — a mis-route would
// silently query the wrong access node and return wrong/empty history. Also pins
// the tx-walk (newest→oldest until a node 200s) and the auth/param guards.

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const env = { SPORK_PROXY_SECRET: "tok" }
const ev = (qs: string, headers: Record<string, string> = { Authorization: "Bearer tok" }) =>
  new Request(`https://p.dev/?${qs}`, { method: "GET", headers })

const upstreamUrl = () => String(fetchMock.mock.calls[0]?.[0] ?? "")

describe("spork-proxy — gates", () => {
  it("answers an unauthenticated health ping (no start_height/tx)", async () => {
    const res = await worker.fetch(new Request("https://p.dev/", { method: "GET" }), env)
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a non-GET method", async () => {
    const res = await worker.fetch(new Request("https://p.dev/?tx=x", { method: "POST" }), env)
    expect(res.status).toBe(405)
  })

  it("401s an events query with no Bearer", async () => {
    const res = await worker.fetch(ev("start_height=1&end_height=2&event_type=A.x", {}), env)
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("spork-proxy — events range validation + spork selection", () => {
  it("400s on missing required params", async () => {
    const res = await worker.fetch(ev("start_height=1&end_height=2"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("missing_required_params")
  })

  it("400s on a non-numeric height", async () => {
    const res = await worker.fetch(ev("start_height=abc&end_height=2&event_type=A.x"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_height")
  })

  it("400s when start_height > end_height", async () => {
    const res = await worker.fetch(ev("start_height=50&end_height=10&event_type=A.x"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_range")
  })

  it("400s at/above the current-spork floor (use public REST instead)", async () => {
    const res = await worker.fetch(ev("start_height=137390146&end_height=137390200&event_type=A.x"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("current_spork_not_supported")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("400s when the range crosses a spork boundary", async () => {
    // start in mainnet17 (<=31,735,954), end in mainnet18 (<=35,858,810)
    const res = await worker.fetch(ev("start_height=31000000&end_height=32000000&event_type=A.x"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("range_crosses_spork_boundary")
  })

  it("routes a single-spork range to the matching access node with the X-Spork-Node header", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"events":[]}', { status: 200 }))
    // both within mainnet19 (<=40,171,633)
    const res = await worker.fetch(ev("start_height=36000000&end_height=37000000&event_type=A.TopShot.Deposit"), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Spork-Node")).toBe("mainnet19")
    const url = upstreamUrl()
    expect(url).toContain("access-001.mainnet19.nodes.onflow.org")
    expect(url).toContain("/v1/events")
    expect(url).toContain("start_height=36000000")
  })

  it("502s when the upstream events fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "TypeError" }))
    const res = await worker.fetch(ev("start_height=36000000&end_height=37000000&event_type=A.x"), env)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("upstream_fetch_failed")
  })

  it("504s when the upstream events fetch aborts (timeout)", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
    const res = await worker.fetch(ev("start_height=36000000&end_height=37000000&event_type=A.x"), env)
    expect(res.status).toBe(504)
    expect((await res.json()).error).toBe("upstream_timeout")
  })
})

describe("spork-proxy — tx-result walk", () => {
  const TX = "a".repeat(64)

  it("400s an invalid (non-hex/short) tx id", async () => {
    const res = await worker.fetch(ev("tx=0xnothex"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_tx_id")
  })

  it("400s an explicit unknown spork", async () => {
    const res = await worker.fetch(ev(`tx=${TX}&spork=mainnet99`), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown_spork")
  })

  it("returns the first spork node that 200s, tagged with X-Spork-Node", async () => {
    // walk is newest→oldest (mainnet27 first). First node 200s.
    fetchMock.mockResolvedValueOnce(new Response("TXBODY", { status: 200, headers: { "Content-Type": "application/json" } }))
    const res = await worker.fetch(ev(`tx=${TX}`), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Spork-Node")).toBe("mainnet27")
    expect(await res.text()).toBe("TXBODY")
  })

  it("404s when no listed spork holds the tx (all 404)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }))
    const res = await worker.fetch(ev(`tx=${TX}&spork=mainnet20`), env)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("tx_not_found_in_listed_sporks")
  })
})
