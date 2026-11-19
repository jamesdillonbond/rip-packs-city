import { describe, it, expect, vi } from "vitest"
import {
  fetchAllDayStudioHoldings,
  unionHoldingTriples,
  stripFlowPrefix,
  parseAtlasOwnerPage,
  type AtlasOwnerPage,
} from "@/lib/chains/flow/allday-studio-holdings"

// 2026-11-18 (#218): the custody walk reads Atlas NFTService/SearchNftsByOwner
// (Studio GraphQL is HTTP 530). Atlas clamps limit to 100 and pages by offset.
const W = "0xdcd41c74d2dd0a66"

type Node = [string | null, string | null, string]
function pageOf(nodes: Node[], totalCount: number | null, hasMore = false): AtlasOwnerPage {
  return {
    nfts: nodes.map(([id, editionId, serialNumber]) => ({ id, editionId, serialNumber })),
    totalCount,
    hasMore,
  }
}

/** A fetcher serving a wallet of `total` moments, 100 per offset page. */
function walletOf(total: number) {
  const calls: Array<{ owner: string; offset: number }> = []
  const fetchPage = vi.fn(async (owner: string, offset: number) => {
    calls.push({ owner, offset })
    const nodes: Node[] = []
    for (let i = offset; i < Math.min(offset + 100, total); i++) nodes.push([String(1000 + i), String(i % 7 + 1), String(i + 1)])
    return pageOf(nodes, total, offset + 100 < total)
  })
  return { fetchPage, calls }
}

describe("stripFlowPrefix", () => {
  // THE footgun: the custody index stores owner addresses as bare hex.
  it("strips the 0x prefix and lowercases", () => {
    expect(stripFlowPrefix("0xDCD41C74D2DD0A66")).toBe("dcd41c74d2dd0a66")
    expect(stripFlowPrefix("dcd41c74d2dd0a66")).toBe("dcd41c74d2dd0a66")
    expect(stripFlowPrefix("  0xdcd41c74d2dd0a66  ")).toBe("dcd41c74d2dd0a66")
  })
})

describe("parseAtlasOwnerPage", () => {
  it("reads nfts + pagination (Atlas sends counts as strings)", () => {
    const p = parseAtlasOwnerPage({
      nfts: [{ id: "6605288", editionId: "2783", serialNumber: "59" }],
      pagination: { limit: "100", offset: "0", hasMore: false, totalCount: "3" },
    })
    expect(p.totalCount).toBe(3)
    expect(p.hasMore).toBe(false)
    expect(p.nfts).toHaveLength(1)
  })

  // An answer without the array is a failure, not a wallet holding nothing.
  it("throws on a body with no nfts array rather than reading it as empty", () => {
    expect(() => parseAtlasOwnerPage({ pagination: { totalCount: "0" } })).toThrow(/no nfts/)
    expect(() => parseAtlasOwnerPage(null)).toThrow(/no nfts/)
  })
})

describe("fetchAllDayStudioHoldings (Atlas)", () => {
  it("asks for the BARE-hex owner, never 0x-prefixed", async () => {
    const { fetchPage, calls } = walletOf(3)
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(true)
    expect(calls[0].owner).toBe("dcd41c74d2dd0a66")
    expect(calls[0].offset).toBe(0)
  })

  it("returns [nftId, editionId, serial] triples (the ThunderHour locked set)", async () => {
    const fetchPage = vi.fn(async () =>
      pageOf(
        [
          ["6590418", "2813", "1"],
          ["6605288", "2783", "59"],
          ["5847644", "2392", "355"],
        ],
        3,
      ),
    )
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(true)
    expect(res.triples).toEqual([
      ["6590418", "2813", "1"],
      ["6605288", "2783", "59"],
      ["5847644", "2392", "355"],
    ])
    expect(res.totalCount).toBe(3)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("walks EVERY offset page of a wallet larger than one page (3,807 moments = 39 pages)", async () => {
    const { fetchPage, calls } = walletOf(3807)
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(true)
    expect(res.triples).toHaveLength(3807)
    expect(res.pagesFetched).toBe(39)
    const offsets = calls.map((c) => c.offset).sort((a, b) => a - b)
    expect(offsets).toEqual(Array.from({ length: 39 }, (_, i) => i * 100))
  })

  it("an exact multiple of the page size fetches no phantom extra page", async () => {
    const { fetchPage, calls } = walletOf(200)
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.triples).toHaveLength(200)
    expect(calls.map((c) => c.offset)).toEqual([0, 100])
  })

  it("de-dupes an id repeated across pages", async () => {
    const fetchPage = vi.fn(async (_o: string, offset: number) =>
      offset === 0 ? pageOf([["1", "10", "5"]], 150, true) : pageOf([["1", "10", "5"], ["2", "11", "6"]], 150),
    )
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.triples.map((t) => t[0])).toEqual(["1", "2"])
  })

  // FAIL-SOFT CONTRACT: an index outage must never break the on-chain backfill,
  // and must never read as "this wallet has no locked moments" (ok stays false,
  // which is what keeps the caller from deleting).
  it("never throws when the first page fails — returns ok:false with the error", async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error("atlas http_403")
    })
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(false)
    expect(res.triples).toEqual([])
    expect(res.error).toContain("403")
  })

  it("ONE failed later page fails the whole walk (a partial list is not the holdings)", async () => {
    const fetchPage = vi.fn(async (_o: string, offset: number) => {
      if (offset === 2300) throw new Error("atlas no response")
      const nodes: Node[] = []
      for (let i = offset; i < Math.min(offset + 100, 3807); i++) nodes.push([String(i + 1), "1", "1"])
      return pageOf(nodes, 3807, offset + 100 < 3807)
    })
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("no response")
  })

  it("refuses to walk blind when Atlas says hasMore but gives no total", async () => {
    const fetchPage = vi.fn(async () => pageOf([["1", "10", "5"]], null, true))
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no totalCount/)
  })

  it("stops at the elapsed budget and reports truncated, not ok", async () => {
    let t = 0
    const { fetchPage } = walletOf(3807)
    const res = await fetchAllDayStudioHoldings(W, {
      fetchPage: async (o, off) => {
        t += 30_000
        return fetchPage(o, off)
      },
      now: () => t,
    })
    expect(res.truncated).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.triples.length).toBeLessThan(3807)
  })

  it("a walk that returns FEWER distinct moments than totalCount is not ok (it could unlock deletes)", async () => {
    // Every offset answers the same row: 50 pages planned, 1 moment seen.
    const fetchPage = vi.fn(async () => pageOf([["1", "10", "5"]], 5000, true))
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/short walk: 1 of 5000/)
  })

  it("rejects a malformed wallet without calling Atlas", async () => {
    const fetchPage = vi.fn()
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchPage: fetchPage as never })
    expect(res.ok).toBe(false)
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it("skips nodes missing an id or edition id (and Atlas's '0' empties) rather than writing a broken key", async () => {
    const fetchPage = vi.fn(async () =>
      pageOf(
        [
          ["1", "10", "5"],
          ["2", null, "6"],
          [null, "12", "7"],
          ["0", "13", "8"],
          ["3", "0", "9"],
        ],
        5,
      ),
    )
    const res = await fetchAllDayStudioHoldings(W, { fetchPage })
    expect(res.triples).toEqual([["1", "10", "5"]])
  })
})

describe("unionHoldingTriples", () => {
  it("adds studio-only (locked) moments the chain cannot see", () => {
    // The real ThunderHour case: chain sees nothing, studio sees the locked set.
    const { merged, addedFromStudio } = unionHoldingTriples(
      [],
      [
        ["6590418", "2813", "1"],
        ["6605288", "2783", "59"],
      ],
    )
    expect(addedFromStudio).toBe(2)
    expect(merged).toHaveLength(2)
  })

  it("lets the CHAIN win on conflict — studio owner_address can be stale", () => {
    const { merged, addedFromStudio } = unionHoldingTriples(
      [["100", "999", "7"]],
      [["100", "111", "42"]],
    )
    expect(addedFromStudio).toBe(0)
    expect(merged).toEqual([["100", "999", "7"]])
  })

  it("is a pure union — never drops a chain moment studio omits", () => {
    // AllDay 1557801 is held on-chain by 0x11859edcf2f53edd while studio still
    // attributes it to a 2022 owner. The chain row must survive.
    const { merged } = unionHoldingTriples([["1557801", "636", "5895"]], [])
    expect(merged).toEqual([["1557801", "636", "5895"]])
  })

  // rows_found has always meant "raw on-chain scan count". The row-builder skips
  // malformed tuples downstream; filtering them here would silently redefine
  // that telemetry field for every AllDay run.
  it("passes malformed chain tuples through verbatim (rows_found semantics)", () => {
    const { merged, addedFromStudio } = unionHoldingTriples(
      [["1"], [], ["2", "20", "3"]] as any,
      [],
    )
    expect(merged).toHaveLength(3)
    expect(addedFromStudio).toBe(0)
  })

  it("does not let a studio moment duplicate a malformed chain entry's id", () => {
    const { merged, addedFromStudio } = unionHoldingTriples(
      [["7"]] as any,
      [["7", "70", "1"]],
    )
    expect(addedFromStudio).toBe(0)
    expect(merged).toHaveLength(1)
  })

  it("counts only genuinely-new studio moments as added", () => {
    const { merged, addedFromStudio } = unionHoldingTriples(
      [["1", "10", "5"]],
      [["1", "10", "5"], ["2", "20", "6"]],
    )
    expect(addedFromStudio).toBe(1)
    expect(merged).toHaveLength(2)
  })
})
