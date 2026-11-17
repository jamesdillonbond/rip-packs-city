import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import worker from "@/workers/pinnacle-events-proxy/index.ts"

// Behavioural coverage for the pinnacle-events-proxy Cloudflare Worker — a
// Bearer(INGEST_SECRET_TOKEN)-gated Flow /v1/events pass-through. Untested. Pins
// the auth + method/path gate, the height/range validation (incl. the 50k-block
// cap that forces callers to paginate), the DEFAULT_EVENT_TYPE (the on-chain
// storefront event, NOT the non-existent Pinnacle.NFTListed), the event
// aggregation + cursor/complete shape, and the chunk-failure 502.

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const env = { INGEST_SECRET_TOKEN: "tok" }
const events = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer tok" }) =>
  new Request("https://p.dev/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
const upstreamUrl = () => String(fetchMock.mock.calls[0]?.[0] ?? "")

describe("pinnacle-events-proxy — gates", () => {
  it("serves an unauthenticated GET health check", async () => {
    const res = await worker.fetch(new Request("https://p.dev/", { method: "GET" }), env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.default_event_type).toContain("NFTStorefrontV2.ListingAvailable")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("405s a POST to the wrong path", async () => {
    const res = await worker.fetch(
      new Request("https://p.dev/wrong", { method: "POST", headers: { Authorization: "Bearer tok" }, body: "{}" }),
      env,
    )
    expect(res.status).toBe(405)
  })

  it("401s POST /events with no/wrong Bearer", async () => {
    expect((await worker.fetch(events({ startHeight: 1, endHeight: 2 }, {}), env)).status).toBe(401)
    expect((await worker.fetch(events({ startHeight: 1, endHeight: 2 }, { Authorization: "Bearer x" }), env)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s when the token is unset (fail closed)", async () => {
    const res = await worker.fetch(events({ startHeight: 1, endHeight: 2 }), { INGEST_SECRET_TOKEN: "" })
    expect(res.status).toBe(401)
  })
})

describe("pinnacle-events-proxy — validation", () => {
  it("400s an invalid JSON body", async () => {
    const res = await worker.fetch(events("{not json"), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json_body")
  })

  it("400s non-numeric heights", async () => {
    const res = await worker.fetch(events({ startHeight: "x", endHeight: 2 }), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_height_args")
  })

  it("400s an inverted range", async () => {
    const res = await worker.fetch(events({ startHeight: 100, endHeight: 50 }), env)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_range")
  })

  it("400s a range above the 50k-block cap", async () => {
    const res = await worker.fetch(events({ startHeight: 0, endHeight: 60_000 }), env)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("range_too_large")
    expect(body.max_range_blocks).toBe(50_000)
  })
})

describe("pinnacle-events-proxy — event walk", () => {
  it("aggregates events across a chunk and reports cursor/complete", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            block_height: "100",
            block_timestamp: "2026-07-20T00:00:00Z",
            events: [
              { payload: "p1", transaction_id: "t1", event_index: 0, type: "A.x.ListingAvailable" },
              { payload: "p2", transaction_id: "t1", event_index: 1, type: "A.x.ListingAvailable" },
            ],
          },
        ]),
        { status: 200 },
      ),
    )
    const res = await worker.fetch(events({ startHeight: 100, endHeight: 200 }), env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(2)
    expect(body.events[0]).toMatchObject({ block_height: 100, transaction_id: "t1", payload: "p1" })
    expect(body.cursor).toBe(201) // endHeight + 1
    expect(body.complete).toBe(true)
    expect(body.blocks_scanned).toBe(101)
    // used the default storefront event type
    expect(upstreamUrl()).toContain("NFTStorefrontV2.ListingAvailable")
  })

  it("honors a caller-supplied eventType override", async () => {
    await worker.fetch(events({ startHeight: 1, endHeight: 100, eventType: "A.custom.Event" }), env)
    expect(upstreamUrl()).toContain("A.custom.Event")
  })

  it("502s with events_so_far when an upstream chunk fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 503 }))
    const res = await worker.fetch(events({ startHeight: 1, endHeight: 100 }), env)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("upstream_chunk_failed")
    expect(body.events_so_far).toBe(0)
  })
})
