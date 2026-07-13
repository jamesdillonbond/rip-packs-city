// Locks in lib/chains/flow/topshot.ts — the topshotGraphql wrapper over the
// public-api.nbatopshot.com endpoint. Pins: successful data unwrap + request
// shape (POST, headers, JSON body), the !ok non-429 throw, the errors-array
// throw (joined messages), the no-data throw, the unparseable-body → no-data
// throw, and the opt-in 429 retry path (Retry-After honored, exhausted
// maxRetries throws). Global fetch is stubbed; Math.random is pinned so the
// backoff jitter sleeps ~0ms.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { topshotGraphql } from "@/lib/chains/flow/topshot"

function resp(opts: {
  ok?: boolean
  status?: number
  body?: unknown
  raw?: string
  retryAfter?: string | null
}) {
  const raw = opts.raw ?? JSON.stringify(opts.body ?? {})
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => raw,
    headers: { get: (k: string) => (k === "retry-after" ? opts.retryAfter ?? null : null) },
  }
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("topshotGraphql", () => {
  it("returns the unwrapped data on success and posts the right request", async () => {
    const fetchMock = vi.fn(async () => resp({ body: { data: { hello: "world" } } }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await topshotGraphql<{ hello: string }>("query {}", { a: 1 })
    expect(data).toEqual({ hello: "world" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://public-api.nbatopshot.com/graphql")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body)).toEqual({ query: "query {}", variables: { a: 1 } })
  })

  it("throws with status + body on a non-429 error response", async () => {
    const fetchMock = vi.fn(async () => resp({ ok: false, status: 500, raw: "server boom" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(topshotGraphql("q")).rejects.toThrow(
      /failed with 500\. Response body: server boom/
    )
  })

  it("throws by default on 429 (retry not opted in)", async () => {
    const fetchMock = vi.fn(async () => resp({ ok: false, status: 429, raw: "rate limited" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(topshotGraphql("q")).rejects.toThrow(/failed with 429/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws the joined GraphQL error messages", async () => {
    const fetchMock = vi.fn(async () =>
      resp({ body: { errors: [{ message: "bad field" }, { message: "" }, { message: "oops" }] } })
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(topshotGraphql("q")).rejects.toThrow("bad field; oops")
  })

  it("throws no-data when the payload has neither data nor errors", async () => {
    const fetchMock = vi.fn(async () => resp({ body: { data: null } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(topshotGraphql("q")).rejects.toThrow(/returned no data/)
  })

  it("throws no-data when the body is not valid JSON", async () => {
    const fetchMock = vi.fn(async () => resp({ raw: "<html>blocked</html>" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(topshotGraphql("q")).rejects.toThrow(/returned no data/)
  })

  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp({ ok: false, status: 429, retryAfter: "0", raw: "429" }))
      .mockResolvedValueOnce(resp({ body: { data: { ok: true } } }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await topshotGraphql<{ ok: boolean }>("q", undefined, { retryOn429: true })
    expect(data).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("throws when 429 retries are exhausted (maxRetries: 0)", async () => {
    const fetchMock = vi.fn(async () => resp({ ok: false, status: 429, raw: "still 429" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      topshotGraphql("q", undefined, { retryOn429: true, maxRetries: 0 })
    ).rejects.toThrow(/failed with 429/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp({ ok: false, status: 429, retryAfter: null, raw: "429" }))
      .mockResolvedValueOnce(resp({ body: { data: { done: 1 } } }))
    vi.stubGlobal("fetch", fetchMock)

    // maxBackoffMs caps the 2s exponential sleep to ~0ms so the test is fast.
    const data = await topshotGraphql<{ done: number }>("q", undefined, {
      retryOn429: true,
      maxBackoffMs: 0,
    })
    expect(data).toEqual({ done: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
