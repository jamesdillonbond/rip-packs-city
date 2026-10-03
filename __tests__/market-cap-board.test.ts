import { describe, it, expect } from "vitest"
import {
  fmtUsdCompact,
  highConfidenceShare,
  resolveCollectionParam,
  rowDetail,
  rowHref,
  rowLabel,
  shapeRow,
  type MarketCapRow,
} from "@/lib/insights/market-cap-board"

const base: MarketCapRow = {
  collection_slug: "nba_top_shot", group_key: "k", group_label: "LeBron James",
  set_name: null, tier: null, series_num: null, series_name: null, edition_external_id: null,
  editions: 1, editions_supply_known: 1, editions_priced: 1,
  minted: 100, burned: 10, issuer_held: 5, collector_held: 85,
  mcap_usd: 850, mcap_high_conf_usd: 425, mcap_minted_usd: 1000, mcap_usd_7d_ago: null,
}

describe("market-cap-board helpers", () => {
  it("resolveCollectionParam: absent = all, unknown = undefined (refuse), known = DB slug", () => {
    expect(resolveCollectionParam(null)).toBeNull()
    expect(resolveCollectionParam("  ")).toBeNull()
    expect(resolveCollectionParam("nba-top-shot")).toBe("nba_top_shot")
    expect(resolveCollectionParam("disney_pinnacle")).toBe("disney_pinnacle")
    expect(resolveCollectionParam("topshot")).toBeUndefined()
  })

  it("shapeRow keeps a missing figure NULL — it never becomes 0", () => {
    const r = shapeRow({ ...base, mcap_usd: null, collector_held: null, burned: null, mcap_high_conf_usd: null })
    expect(r.mcap_usd).toBeNull()
    expect(r.collector_held).toBeNull()
    expect(r.burned).toBeNull()
    expect(highConfidenceShare(r)).toBeNull()
    expect(fmtUsdCompact(r.mcap_usd)).toBe("—")
  })

  it("shapeRow throws on a non-numeric count rather than inventing one", () => {
    expect(() => shapeRow({ ...base, editions: "abc" })).toThrow()
  })

  it("high-confidence share is a ratio of the known cap", () => {
    expect(highConfidenceShare(base)).toBe(0.5)
  })

  it("decodes series per collection — Top Shot's 0 is Series 1, All Day's 1 is Series 1", () => {
    expect(rowLabel({ ...base, series_num: 0 }, "series")).toBe("Series 1")
    expect(rowLabel({ ...base, collection_slug: "nfl_all_day", series_num: 1 }, "series")).toBe("Series 1")
    expect(rowLabel({ ...base, collection_slug: "disney_pinnacle", series_name: "Series 2" }, "series")).toBe("Series 2")
    expect(rowLabel({ ...base }, "collection")).toBe("NBA Top Shot")
  })

  it("edition detail carries set, tier and decoded series", () => {
    expect(rowDetail({ ...base, set_name: "Cosmic", tier: "LEGENDARY", series_num: 0 }, "edition")).toBe("Cosmic · LEGENDARY · Series 1")
  })

  it("links each grain to its canonical page, and nothing where no page exists", () => {
    expect(rowHref(base, "collection")).toBe("/nba-top-shot/overview")
    expect(rowHref({ ...base, edition_external_id: "2:133" }, "edition")).toBe("/nba-top-shot/edition/2%3A133")
    expect(rowHref({ ...base, collection_slug: "disney_pinnacle", edition_external_id: "r1" }, "edition")).toBe("/pinnacle/moment/r1")
    expect(rowHref(base, "player")).toMatch(/^\/nba-top-shot\/player\/lebron-james$/)
    expect(rowHref({ ...base, group_label: "Los Angeles Lakers" }, "team")).toBe("/nba-top-shot/team/los-angeles-lakers")
    expect(rowHref({ ...base, set_name: "Base Set" }, "set")).toBe("/nba-top-shot/set/base-set")
    expect(rowHref(base, "tier")).toBeNull()
    expect(rowHref(base, "badge")).toBeNull()
    expect(rowHref({ ...base, collection_slug: "not_a_collection" }, "player")).toBeNull()
  })
})

describe("market-cap formatters", () => {
  it("print negatives sign-first and unknowns as a dash", async () => {
    const { fmtUsdCompact, fmtCount } = await import("@/lib/insights/market-cap-format")
    expect(fmtUsdCompact(-2_500_000)).toBe("-$2.50M")
    expect(fmtUsdCompact(51_757_657.83)).toBe("$51.76M")
    expect(fmtUsdCompact(12_500)).toBe("$12.5K")
    expect(fmtUsdCompact(950)).toBe("$950")
    expect(fmtUsdCompact(null)).toBe("—")
    expect(fmtCount(null)).toBe("—")
    expect(fmtCount(33_699_893)).toBe("33,699,893")
  })
})
