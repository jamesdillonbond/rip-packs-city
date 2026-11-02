import { describe, it, expect } from "vitest"
import {
  buildChaseRows,
  fmtPer100,
  fmtVsLaunch,
  isBuyableNow,
  parseChaseSort,
  parseChaseTier,
  type AtlasChaseInput,
  type PackMetaInput,
} from "@/lib/packs/chase-odds"

// "Chase left" math (lib/packs/chase-odds.ts). Fixture numbers are the live
// Atlas rows read 2026-11-01 for dists 8903 (Rookie Year Royalty) and 8908.

const NOW = Date.parse("2026-11-02T04:00:00Z")
const FRESH = "2026-11-01T17:19:00Z"

function atlas(over: Partial<AtlasChaseInput> = {}): AtlasChaseInput {
  return {
    dist_id: "8903",
    title: "Rookie Year Royalty Pack",
    summary_fetched_at: FRESH,
    unopened_count: 18,
    total_pack_count: 719,
    remaining_by_tier: { legendary: "1", rare: "0", common: "53" },
    original_by_tier: { legendary: "3", rare: "23", common: "2131" },
    ...over,
  }
}

function meta(over: Partial<PackMetaInput> = {}): PackMetaInput {
  return {
    dist_id: "8903",
    title: "Rookie Year Royalty Pack",
    image_url: null,
    primary_available: false,
    secondary_available: true,
    ev_snapshotted_at: "2026-11-01T20:00:00Z",
    observed_packs_opened: 600,
    ...over,
  }
}

const opts = { tier: "legendary" as const, sort: "now" as const, buyableOnly: false, nowMs: NOW, availabilityMaxAgeHours: 72 }

describe("buildChaseRows", () => {
  it("computes today's density against launch", () => {
    const { rows } = buildChaseRows([atlas()], new Map([["8903", meta()]]), opts)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.remaining).toBe(1)
    expect(r.unopened).toBe(18)
    expect(r.per100Now).toBeCloseTo(100 / 18, 6)
    expect(r.per100Launch).toBeCloseTo(300 / 719, 6)
    expect(r.vsLaunch).toBeCloseTo((100 / 18) / (300 / 719), 6)
    expect(r.buyable).toBe(true)
    expect(r.asOf).toBe(FRESH)
  })

  it("drops a payload our observed on-chain opens refute, and counts it", () => {
    // 719 − 18 = 701 opened per Dapper; we watched 702 open → refuted.
    const res = buildChaseRows([atlas()], new Map([["8903", meta({ observed_packs_opened: 702 })]]), opts)
    expect(res.rows).toHaveLength(0)
    expect(res.refuted).toBe(1)
  })

  it("drops a payload older than the max age instead of showing it as current", () => {
    const res = buildChaseRows([atlas({ summary_fetched_at: "2026-10-20T00:00:00Z" })], new Map(), opts)
    expect(res.rows).toHaveLength(0)
    expect(res.stale).toBe(1)
  })

  it("drops internally inconsistent tier counts (more left than launched)", () => {
    const res = buildChaseRows([atlas({ remaining_by_tier: { legendary: "4" } })], new Map(), opts)
    expect(res.rows).toHaveLength(0)
  })

  it("never lists a dist with none of the tier left", () => {
    const res = buildChaseRows([atlas()], new Map(), { ...opts, tier: "rare" })
    expect(res.rows).toHaveLength(0)
  })

  it("buyableOnly needs a FRESH affirmative availability flag", () => {
    const stale = meta({ ev_snapshotted_at: "2026-10-01T00:00:00Z" })
    expect(buildChaseRows([atlas()], new Map([["8903", stale]]), { ...opts, buyableOnly: true }).rows).toHaveLength(0)
    expect(buildChaseRows([atlas()], new Map(), { ...opts, buyableOnly: true }).rows).toHaveLength(0)
    expect(buildChaseRows([atlas()], new Map([["8903", meta()]]), { ...opts, buyableOnly: true }).rows).toHaveLength(1)
  })

  it("sorts by the chosen key", () => {
    const big = atlas({ dist_id: "8908", title: "Keaton Wagler Tip-Off Pack", unopened_count: 1079, total_pack_count: 1500, remaining_by_tier: { legendary: "1" }, original_by_tier: { legendary: "4" } })
    const many = atlas({ dist_id: "9000", unopened_count: 500, total_pack_count: 1000, remaining_by_tier: { legendary: "5" }, original_by_tier: { legendary: "5" } })
    const m = new Map<string, PackMetaInput>()
    const byNow = buildChaseRows([big, many, atlas()], m, opts).rows.map((r) => r.distId)
    expect(byNow).toEqual(["8903", "9000", "8908"])
    const byLeft = buildChaseRows([big, many, atlas()], m, { ...opts, sort: "remaining" }).rows.map((r) => r.distId)
    expect(byLeft[0]).toBe("9000")
    const byVs = buildChaseRows([big, many, atlas()], m, { ...opts, sort: "vsLaunch" }).rows.map((r) => r.distId)
    expect(byVs[0]).toBe("8903")
  })
})

describe("helpers", () => {
  it("parses tier and sort with safe defaults", () => {
    expect(parseChaseTier("RARE")).toBe("rare")
    expect(parseChaseTier("common")).toBe("legendary")
    expect(parseChaseSort("vsLaunch")).toBe("vsLaunch")
    expect(parseChaseSort("x")).toBe("vsLaunch")
  })
  it("isBuyableNow refuses a null stamp", () => {
    expect(isBuyableNow(meta({ ev_snapshotted_at: null }), NOW, 72)).toBe(false)
  })
  it("formats without false precision and never calls a density a percent", () => {
    expect(fmtPer100(100 / 18)).toBe("5.6")
    expect(fmtPer100(300 / 719)).toBe("0.42")
    expect(fmtPer100(25)).toBe("25")
    expect(fmtVsLaunch(13.3)).toBe("13× launch rate")
    expect(fmtVsLaunch(1.05)).toBe("≈ launch rate")
    expect(fmtVsLaunch(0.5)).toBe("0.5× launch rate")
    expect(fmtPer100(5.6)).not.toContain("%")
  })
})
