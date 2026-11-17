import { describe, it, expect, vi } from "vitest"
import {
  fetchAllDayStudioHoldings,
  unionHoldingTriples,
  stripFlowPrefix,
} from "@/lib/chains/flow/allday-studio-holdings"

// Builds a studio-shaped GQL response page.
function page(nodes: Array<[string, string, string]>, totalCount: number | null = null) {
  return {
    data: {
      searchAllDayNft: {
        totalCount,
        edges: nodes.map(([id, editionId, serial]) => ({
          cursor: `cur_${id}`,
          node: { id, serial_number: serial, edition: { id: editionId } },
        })),
      },
    },
  }
}

function mockFetch(pages: unknown[]) {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  let i = 0
  const impl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    const payload = pages[Math.min(i, pages.length - 1)]
    i++
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    } as any
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

describe("stripFlowPrefix", () => {
  // THE footgun: studio stores owner_address as bare hex. A 0x-prefixed query
  // returns totalCount 0 — a silent empty, not an error.
  it("strips the 0x prefix and lowercases", () => {
    expect(stripFlowPrefix("0xDCD41C74D2DD0A66")).toBe("dcd41c74d2dd0a66")
    expect(stripFlowPrefix("dcd41c74d2dd0a66")).toBe("dcd41c74d2dd0a66")
    expect(stripFlowPrefix("  0xdcd41c74d2dd0a66  ")).toBe("dcd41c74d2dd0a66")
  })
})

describe("fetchAllDayStudioHoldings", () => {
  it("queries studio with BARE-hex owner_address, never 0x-prefixed", async () => {
    const { impl, calls } = mockFetch([page([["6590418", "2813", "1"]], 1)])
    const res = await fetchAllDayStudioHoldings("0xdcd41c74d2dd0a66", { fetchImpl: impl })

    expect(res.ok).toBe(true)
    const filters = calls[0].body.variables.input.filters
    expect(filters[0].owner_address.eq).toBe("dcd41c74d2dd0a66")
    expect(filters[0].owner_address.eq).not.toMatch(/^0x/)
  })

  it("sends the Origin header studio requires", async () => {
    const { impl, calls } = mockFetch([page([], 0)])
    await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(calls[0].headers.Origin).toBe("https://nflallday.com")
  })

  it("returns [nftId, editionId, serial] triples", async () => {
    const { impl } = mockFetch([
      page(
        [
          ["6590418", "2813", "1"],
          ["6605288", "2783", "59"],
          ["5847644", "2392", "355"],
        ],
        3,
      ),
    ])
    const res = await fetchAllDayStudioHoldings("0xdcd41c74d2dd0a66", { fetchImpl: impl })
    expect(res.ok).toBe(true)
    expect(res.triples).toEqual([
      ["6590418", "2813", "1"],
      ["6605288", "2783", "59"],
      ["5847644", "2392", "355"],
    ])
    expect(res.totalCount).toBe(3)
  })

  it("paginates via cursor until totalCount is satisfied", async () => {
    const { impl, calls } = mockFetch([
      page([["1", "10", "5"]], 2),
      page([["2", "11", "6"]], 1),
    ])
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.triples.map((t) => t[0])).toEqual(["1", "2"])
    // page 2 must resume from page 1's last cursor
    expect(calls[1].body.variables.input.after).toBe("cur_1")
    // totalCount is taken from page 1 (studio decrements it per page)
    expect(res.totalCount).toBe(2)
  })

  it("stops on an empty page without spinning", async () => {
    const { impl, calls } = mockFetch([page([["1", "10", "5"]], 99), page([], 99)])
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.triples).toHaveLength(1)
    expect(calls.length).toBe(2)
  })

  it("de-dupes repeated nft ids across pages", async () => {
    const { impl } = mockFetch([
      page([["1", "10", "5"]], 3),
      page([["1", "10", "5"]], 2),
      page([], 1),
    ])
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.triples).toHaveLength(1)
  })

  // FAIL-SOFT CONTRACT: a studio outage must never break the on-chain backfill.
  it("never throws on an HTTP error — returns ok:false", async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "upstream unavailable",
    })) as unknown as typeof fetch
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.ok).toBe(false)
    expect(res.triples).toEqual([])
    expect(res.error).toContain("503")
  })

  it("never throws on a GraphQL error payload — returns ok:false", async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errors: [{ message: "Unknown type" }] }),
    })) as unknown as typeof fetch
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("Unknown type")
  })

  it("never throws when fetch itself rejects", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("ECONNRESET")
  })

  it("skips nodes missing an id or edition id rather than writing a broken key", async () => {
    const { impl } = mockFetch([
      {
        data: {
          searchAllDayNft: {
            totalCount: 3,
            edges: [
              { cursor: "a", node: { id: "1", serial_number: "5", edition: { id: "10" } } },
              { cursor: "b", node: { id: "2", serial_number: "6", edition: null } },
              { cursor: "c", node: { id: null, serial_number: "7", edition: { id: "12" } } },
            ],
          },
        },
      },
      page([], 2),
    ])
    const res = await fetchAllDayStudioHoldings("0xabc", { fetchImpl: impl })
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
