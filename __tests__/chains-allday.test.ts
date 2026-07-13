// Locks in lib/chains/flow/allday.ts — the NFL All Day *public-api* GraphQL
// helper (public-api.nflallday.com/graphql). Pins: successful data unwrap +
// request shape (posts to the public-api URL), the !ok throw, the errors-array
// throw (joined messages), the no-data throw, and the unparseable-body →
// no-data throw. Global fetch is stubbed; no real network is touched. Note this
// module's alldayGraphql is a *different* export from the consumer helper in
// alldayGraphql.ts (different endpoint), so it is imported in isolation here.

import { describe, it, expect, vi, afterEach } from "vitest"
import { alldayGraphql } from "@/lib/chains/flow/allday"

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

describe("alldayGraphql (public-api endpoint)", () => {
  it("returns unwrapped data and posts to the public-api URL", async () => {
    const fetchMock = vi.fn(async () => resp({ body: { data: { moment: "x" } } }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await alldayGraphql<{ moment: string }>("q", { id: "1" })
    expect(data).toEqual({ moment: "x" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://public-api.nflallday.com/graphql")
    expect(init.method).toBe("POST")
    expect(init.cache).toBe("no-store")
    expect(JSON.parse(init.body)).toEqual({ query: "q", variables: { id: "1" } })
  })

  it("throws with status + body on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => resp({ ok: false, status: 502, raw: "bad gateway" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(
      /GraphQL failed with 502\. Response body: bad gateway/
    )
  })

  it("throws the joined GraphQL error messages", async () => {
    const fetchMock = vi.fn(async () =>
      resp({ body: { errors: [{ message: "field a" }, { message: "" }, { message: "field b" }] } })
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow("field a; field b")
  })

  it("throws no-data when data is absent", async () => {
    const fetchMock = vi.fn(async () => resp({ body: { data: null } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(/returned no data/)
  })

  it("throws no-data when the body is not valid JSON", async () => {
    const fetchMock = vi.fn(async () => resp({ raw: "<html>403</html>" }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(alldayGraphql("q")).rejects.toThrow(/returned no data/)
  })
})
