import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { priceMatchesCents, topShotMomentUrl } from "@/lib/verify-wallet-gql"

// lib/verify-wallet-gql.ts — Top Shot GQL helper backing the wallet
// listing-challenge. Pure helpers (priceMatchesCents / topShotMomentUrl) are
// pinned statically; fetchMomentListingState is exercised over a stubbed fetch
// with a freshly-imported module per env config so the x-proxy-secret header
// branch, the found/not-found parse, and the HTTP/non-JSON/GQL-error throws are
// all covered.

// ── pure helpers ───────────────────────────────────────────────────────────
describe("priceMatchesCents", () => {
  it("matches to the cent", () => {
    expect(priceMatchesCents(10.0, 10.0)).toBe(true)
    expect(priceMatchesCents(10.01, 10.01)).toBe(true)
    expect(priceMatchesCents(10.005 + 0.005, 10.01)).toBe(true)
  })

  it("rejects a mismatch by a cent or more", () => {
    expect(priceMatchesCents(10.0, 10.01)).toBe(false)
    expect(priceMatchesCents(9.99, 10.0)).toBe(false)
  })

  it("rejects null / non-finite price", () => {
    expect(priceMatchesCents(null, 10)).toBe(false)
    expect(priceMatchesCents(Infinity, 10)).toBe(false)
    expect(priceMatchesCents(NaN, 10)).toBe(false)
  })
})

describe("topShotMomentUrl", () => {
  it("builds the native moment page url, encoding the id", () => {
    expect(topShotMomentUrl("999")).toBe("https://nbatopshot.com/moment/999")
    expect(topShotMomentUrl("a b")).toBe("https://nbatopshot.com/moment/a%20b")
  })
})

// ── fetchMomentListingState (stubbed fetch) ────────────────────────────────
const fetchMock = vi.fn()

function res(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body }
}

// Re-import the module with a controlled env so the module-level TS_GQL /
// TS_PROXY_SECRET consts capture the values under test.
async function load(opts: { url?: string; secret?: string | undefined }) {
  vi.resetModules()
  if (opts.url === undefined) delete process.env.TS_PROXY_URL
  else process.env.TS_PROXY_URL = opts.url
  if (opts.secret === undefined) delete process.env.TS_PROXY_SECRET
  else process.env.TS_PROXY_SECRET = opts.secret
  return await import("@/lib/verify-wallet-gql")
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchMomentListingState", () => {
  it("POSTs to the configured proxy with the x-proxy-secret header and parses a found+for-sale moment", async () => {
    const { fetchMomentListingState } = await load({
      url: "https://proxy.example/gql",
      secret: "sekret",
    })
    fetchMock.mockResolvedValueOnce(
      res(JSON.stringify({ data: { getMintedMoment: { data: { forSale: true, price: "12.5", isLocked: false } } } }))
    )
    const out = await fetchMomentListingState("abc")
    expect(out).toEqual({
      momentId: "abc",
      found: true,
      forSale: true,
      price: 12.5,
      isLocked: false,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://proxy.example/gql")
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["x-proxy-secret"]).toBe("sekret")
    const payload = JSON.parse(init.body as string)
    expect(payload.variables).toEqual({ id: "abc" })
    expect(payload.query).toContain("getMintedMoment")
  })

  it("omits the x-proxy-secret header when no secret is configured", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: undefined })
    fetchMock.mockResolvedValueOnce(
      res(JSON.stringify({ data: { getMintedMoment: { data: { forSale: false, price: null, isLocked: true } } } }))
    )
    await fetchMomentListingState("m1")
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers["x-proxy-secret"]).toBeUndefined()
  })

  it("returns found=false with defaulted fields when the moment node is null", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: "s" })
    fetchMock.mockResolvedValueOnce(
      res(JSON.stringify({ data: { getMintedMoment: { data: null } } }))
    )
    const out = await fetchMomentListingState("gone")
    expect(out).toEqual({
      momentId: "gone",
      found: false,
      forSale: false,
      price: null,
      isLocked: false,
    })
  })

  it("coerces a non-finite / missing price to null", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: "s" })
    fetchMock.mockResolvedValueOnce(
      res(JSON.stringify({ data: { getMintedMoment: { data: { forSale: true, price: "not-a-number", isLocked: false } } } }))
    )
    const out = await fetchMomentListingState("x")
    expect(out.found).toBe(true)
    expect(out.price).toBeNull()
  })

  it("throws on a non-2xx proxy response, embedding the status", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: "s" })
    fetchMock.mockResolvedValueOnce(res("upstream boom", false, 502))
    await expect(fetchMomentListingState("x")).rejects.toThrow("Top Shot GQL HTTP 502: upstream boom")
  })

  it("throws when the body is not valid JSON", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: "s" })
    fetchMock.mockResolvedValueOnce(res("<html>blocked</html>"))
    await expect(fetchMomentListingState("x")).rejects.toThrow("Top Shot GQL returned non-JSON")
  })

  it("throws with the joined message list when GQL returns errors", async () => {
    const { fetchMomentListingState } = await load({ url: "https://proxy.example/gql", secret: "s" })
    fetchMock.mockResolvedValueOnce(
      res(JSON.stringify({ errors: [{ message: "bad id" }, { message: "again" }] }))
    )
    await expect(fetchMomentListingState("x")).rejects.toThrow("bad id; again")
  })
})
