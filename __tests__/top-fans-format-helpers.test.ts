import { describe, it, expect, vi } from "vitest"

// The Top Collector Leaderboard's client-safe helpers and server reader: ranking
// tie-breaks, the per-collection source note, the owner link and the reader's
// three states.

const rpcResult = vi.hoisted(() => ({ value: { row: null as unknown, ok: true } }))
vi.mock("@/lib/entity-section-rpc", () => ({
  sectionRowResult: vi.fn(async () => rpcResult.value),
}))

const fmt = await import("@/lib/entity/top-fans-format")
const { fetchTopFans } = await import("@/lib/entity/top-fans")

const r = (owner: string, items: number, fmv: number | null, special: number | null = 0) => ({
  owner,
  username: null,
  items,
  special_items: special,
  fmv_usd: fmv,
  fmv_items: items,
})

describe("rankTopFans tie-breaks", () => {
  it("items ties break on FMV, then owner", () => {
    const out = fmt.rankTopFans([r("0xb", 3, 10), r("0xa", 3, 10), r("0xc", 3, 20)], "items")
    expect(out.map((x) => x.owner)).toEqual(["0xc", "0xa", "0xb"])
  })
  it("FMV ties break on count; a null FMV ranks last", () => {
    const out = fmt.rankTopFans([r("0xa", 1, 5), r("0xb", 4, 5), r("0xn", 9, null)], "fmv")
    expect(out.map((x) => x.owner)).toEqual(["0xb", "0xa", "0xn"])
  })
  it("the special ranking drops owners with no special serial", () => {
    const out = fmt.rankTopFans([r("0xa", 1, 5, 0), r("0xb", 1, 5, 2), r("0xc", 1, 5, null)], "special")
    expect(out.map((x) => x.owner)).toEqual(["0xb"])
  })
  it("identical rows keep a stable order", () => {
    const out = fmt.rankTopFans([r("0xa", 1, 1), r("0xa", 1, 1)], "items")
    expect(out).toHaveLength(2)
  })
})

describe("topFansSourceNote", () => {
  it.each(["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc-strike", "candy-mlb", "panini-blockchain", "disney-pinnacle", "something-else"])(
    "%s says where the count comes from",
    (slug) => {
      expect(fmt.topFansSourceNote(slug).length).toBeGreaterThan(10)
    },
  )
  it("the walked-wallet collections never claim completeness", () => {
    for (const s of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc-strike"]) {
      expect(fmt.topFansSourceNote(s)).toMatch(/won't appear/)
    }
  })
})

describe("topFanHref", () => {
  it("links Panini by username and every other collection by wallet", () => {
    expect(fmt.topFanHref("panini-blockchain", "a b")).toBe("/panini-blockchain/collection?username=a%20b")
    expect(fmt.topFanHref("nba-top-shot", "0xabc")).toBe("/nba-top-shot/collection?wallet=0xabc")
  })
})

describe("rankingIsCensus", () => {
  it("no data is never a ranking", () => {
    expect(fmt.rankingIsCensus("panini-blockchain", null)).toBe(false)
  })
  it("the reader's flag wins over the static set, both ways", () => {
    expect(fmt.rankingIsCensus("nba-top-shot", { census_complete: true })).toBe(true)
    expect(fmt.rankingIsCensus("panini-blockchain", { census_complete: false })).toBe(false)
    expect(fmt.rankingIsCensus("candy-mlb", { census_complete: null })).toBe(true)
  })
})

describe("normalizeTopFans", () => {
  it("rejects a non-object and drops rows without an owner", () => {
    expect(fmt.normalizeTopFans(null)).toBeNull()
    const d = fmt.normalizeTopFans({ rows: [{ owner: "0xa", items: "2", username: " " }, { items: 3 }, null], items: "x" })!
    expect(d.rows).toEqual([{ owner: "0xa", username: null, items: 2, special_items: null, fmv_usd: null, fmv_items: 0 }])
    expect(d.items).toBe(0)
    expect(d.census_complete).toBeNull()
    expect(d.special_tracked).toBe(true)
  })
})

describe("fetchTopFans", () => {
  it("normalises an ok read", async () => {
    rpcResult.value = { row: { rows: [{ owner: "0xa", items: 1 }], census_complete: true }, ok: true }
    const out = await fetchTopFans({ collectionId: "c", kind: "team", key: "blazers" })
    expect(out.ok).toBe(true)
    expect(out.data?.census_complete).toBe(true)
  })
  it("a failed read returns no data rather than an empty ranking", async () => {
    rpcResult.value = { row: null, ok: false }
    const out = await fetchTopFans({ collectionId: "c", kind: "player", key: "1", name: "Damian Lillard", limit: 5 })
    expect(out).toEqual({ ok: false, data: null })
  })
})
