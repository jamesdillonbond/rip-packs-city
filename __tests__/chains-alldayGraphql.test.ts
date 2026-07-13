// Locks in lib/chains/flow/alldayGraphql.ts — the NFL All Day *consumer*
// GraphQL helper (nflallday.com/consumer/graphql). Pins: successful data
// unwrap + request shape, the !ok throw, the errors-array throw, the no-data
// throw, the unparseable-body → no-data throw, and the two module exports
// (ALLDAY_COLLECTION_ADDRESS constant + GET_ALLDAY_EDITIONS query shape).
// Global fetch is stubbed; no real network is touched.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  alldayGraphql,
  ALLDAY_COLLECTION_ADDRESS,
  GET_ALLDAY_EDITIONS,
} from "@/lib/chains/flow/alldayGraphql"

function resp(opts: { ok?: boolean; status?: number; body?: unknown; raw?: string }) {
  const raw = opts.raw ?? JSON.stringify(opts.body ?? {})
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => raw,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("alldayGraphql (consumer endpoint)", () => {
  it("returns unwrapped data and posts to the consumer URL", async () => {
    const fetchMock = vi.fn(async () => resp({ body: { data: { edition: 1 } } }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await alldayGraphql<{ edition: number }>("q", { first: 10 })
    expect(data).toEqual({ edition: 1 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://nflallday.com/consumer/graphql")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ query: "q", variables: { first: 10 } })
  })

  it("throws with status + body on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => resp({ ok: false, status: 403, raw: "waf blocked" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(
      /consumer GraphQL failed with 403\. Response body: waf blocked/
    )
  })

  it("throws the joined GraphQL error messages", async () => {
    const fetchMock = vi.fn(async () =>
      resp({ body: { errors: [{ message: "no such field" }, { message: "" }] } })
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(/errors: no such field/)
  })

  it("throws no-data when data is absent", async () => {
    const fetchMock = vi.fn(async () => resp({ body: {} }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(/returned no data/)
  })

  it("throws no-data when the body is not valid JSON", async () => {
    const fetchMock = vi.fn(async () => resp({ raw: "not json at all" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(/returned no data/)
  })
})

describe("module exports", () => {
  it("exposes the AllDay collection address", () => {
    expect(ALLDAY_COLLECTION_ADDRESS).toBe("0xe4cf4bdc1751c65d")
  })

  it("exposes a GET_ALLDAY_EDITIONS query with pagination fields", () => {
    expect(GET_ALLDAY_EDITIONS).toContain("allEditions")
    expect(GET_ALLDAY_EDITIONS).toContain("hasNextPage")
    expect(GET_ALLDAY_EDITIONS).toContain("endCursor")
  })
})
