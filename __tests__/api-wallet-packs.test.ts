import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet-packs. Requires ?wallet= → 400
// before any GraphQL work. A raw 0x address skips username resolution; a
// username is resolved to a flowAddress via topshotGraphql first. The Studio
// pack-aggregation API is paged (hasNextPage) and Sealed packs are aggregated
// by dist_id + title. GraphQL/network failures degrade to an empty 200 (never
// a 500); an unresolvable username is a 400.

const gql: { flowAddress: string | null; throwErr: Error | null } = { flowAddress: null, throwErr: null }
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (gql.throwErr) throw gql.throwErr
    return { getUserProfileByUsername: { publicInfo: { flowAddress: gql.flowAddress } } }
  },
}))

import { GET } from "@/app/api/wallet-packs/route"

const req = (u: string) => ({ url: u }) as any

function studioPage(edges: any[], hasNextPage = false, endCursor: string | null = null) {
  return {
    json: async () => ({
      data: { searchPackNftAggregation: { pageInfo: { endCursor, hasNextPage }, totalCount: edges.length, edges } },
    }),
  }
}
const edge = (distId: string, title: string) => ({
  node: { dist_id: { key: "k", value: distId }, distribution: { uuid: { value: "u" }, title: { value: title } } },
})

beforeEach(() => {
  gql.flowAddress = null
  gql.throwErr = null
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/wallet-packs", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/wallet-packs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })

  it("200s and aggregates owned sealed packs by dist_id + title (0x address, one page)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => studioPage([edge("d1", "Pack A"), edge("d1", "Pack A")])))
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddress).toBe("0xbd94cade097e50ac")
    expect(body.totalSealedPacks).toBe(2)
    expect(body.owned.d1).toBe(2)
    expect(body.packsByTitle["Pack A"]).toBe(2)
  })

  it("pages through hasNextPage and merges both pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(studioPage([edge("d1", "Pack A")], true, "CUR"))
      .mockResolvedValueOnce(studioPage([edge("d1", "Pack A"), edge("d2", "Pack B")]))
    vi.stubGlobal("fetch", fetchMock)
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    const body = await res.json()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body.totalSealedPacks).toBe(3)
    expect(body.owned).toEqual({ d1: 2, d2: 1 })
    // second page's fetch carried the cursor from page one
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.after).toBe("CUR")
  })

  it("resolves a username to a flowAddress before paging (adds the 0x prefix)", async () => {
    gql.flowAddress = "bd94cade097e50ac" // no 0x prefix from the profile API
    vi.stubGlobal("fetch", vi.fn(async () => studioPage([edge("d1", "Pack A")])))
    const res = await GET(req("https://t/api/wallet-packs?wallet=@trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).walletAddress).toBe("0xbd94cade097e50ac")
  })

  it("400s when a username cannot be resolved", async () => {
    gql.flowAddress = null // profile lookup returns no address
    const res = await GET(req("https://t/api/wallet-packs?wallet=@ghost"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("not_found")
    // Fixed copy, not the resolver's thrown text.
    expect(body.error).toMatch(/wallet or username/i)
    expect(body.error).not.toContain("Could not resolve")
  })

  it("degrades GraphQL errors to an empty 200 (never a 500)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ errors: [{ message: "rate limited" }] }) })))
    const res = await GET(req("https://t/api/wallet-packs?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddress).toBeNull()
    expect(body.totalSealedPacks).toBe(0)
    expect(body.error).not.toContain("rate limited")

    // ⚠ THE `error` KEY IS A LOAD-BEARING CONTRACT, NOT DECORATION (2026-08-29).
    // `totalSealedPacks: 0` and `packsByTitle: {}` on this path are byte-identical
    // to a wallet that genuinely holds no packs, so `error` is the ONLY thing that
    // tells them apart — and CollectionTabClient now discriminates on exactly it
    // (`if (!d || d.error) setPacksFailed(true)`) to draw a distinguishable cell.
    // Dropping the key here would silently restore the defect in a file nobody
    // editing this route would think to open, so it is asserted POSITIVELY: a
    // non-empty string, and the empty map alongside it.
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
    expect(body.packsByTitle).toEqual({})
  })
})
