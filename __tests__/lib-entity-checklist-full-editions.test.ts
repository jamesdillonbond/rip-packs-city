import { describe, it, expect } from "vitest"
import {
  checklistHasParallels,
  computePlayProgress,
  groupChecklistByPlay,
  isParallelKey,
  parseParallelsMode,
  playKeyOf,
  versionPrice,
  type ChecklistEditionRow,
} from "@/lib/entity/checklist-plays"

// The "Ignore parallels" checklist mode (concierge request 2026-09-29): a play
// is collected when ANY version is owned; a missing play costs its CHEAPEST
// priced version; an unpriced missing play is never counted as $0.

const row = (route_slug: string, o: Partial<ChecklistEditionRow> = {}): ChecklistEditionRow => ({
  route_slug, tier: "COMMON", fmv_usd: null, floor_usd: null, fmv_confidence: "HIGH", owned: false, owned_count: 0, owned_locked: false, ...o,
})

describe("play keys", () => {
  it("folds a Top Shot parallel key onto its play and leaves a base key alone", () => {
    expect(playKeyOf("10:106::3")).toBe("10:106")
    expect(playKeyOf("10:106")).toBe("10:106")
    expect(isParallelKey("10:106::3")).toBe(true)
    expect(isParallelKey("10:106")).toBe(false)
  })
  it("reports no parallels for keys without the suffix (All Day / Golazos / Pinnacle shapes)", () => {
    expect(checklistHasParallels([{ route_slug: "1" }, { route_slug: "ABUS-MAGOMEDOV-KO-1000" }, { route_slug: "aaron-judge" }])).toBe(false)
    expect(checklistHasParallels([{ route_slug: "10:106" }, { route_slug: "10:106::3" }])).toBe(true)
    expect(checklistHasParallels([])).toBe(false)
  })
  it("parses the URL mode, defaulting anything unknown to all", () => {
    expect(parseParallelsMode("exclude")).toBe("exclude")
    expect(parseParallelsMode(null)).toBe("all")
    expect(parseParallelsMode("EXCLUDE")).toBe("all")
  })
})

describe("versionPrice", () => {
  it("uses floor, then FMV, and never invents a price", () => {
    expect(versionPrice({ floor_usd: 5, fmv_usd: 9 })).toBe(5)
    expect(versionPrice({ floor_usd: null, fmv_usd: 9 })).toBe(9)
    expect(versionPrice({ floor_usd: 0, fmv_usd: 0 })).toBeNull()
    expect(versionPrice({ floor_usd: null, fmv_usd: null })).toBeNull()
  })
})

describe("groupChecklistByPlay", () => {
  const editions = [
    row("1:1", { floor_usd: 10, fmv_usd: 12 }),
    row("1:1::2", { floor_usd: 4, fmv_usd: 6, owned: true, owned_count: 2, owned_locked: true }),
    row("1:1::3", { floor_usd: 30 }),
    row("1:2", { floor_usd: 20, fmv_usd: 25 }),
    row("1:2::2", { fmv_usd: 8, fmv_confidence: "LOW" }),
    row("1:3"),
  ]

  it("counts a play owned when only a PARALLEL is owned, and the base tile represents it", () => {
    const plays = groupChecklistByPlay(editions, true)
    expect(plays).toHaveLength(3)
    const p1 = plays.find((p) => p.play_key === "1:1")!
    expect(p1.route_slug).toBe("1:1") // the standard edition, not the parallel
    expect(p1.owned).toBe(true)
    expect(p1.owned_versions).toBe(1)
    expect(p1.owned_count).toBe(2)
    expect(p1.owned_locked).toBe(true)
    expect(p1.version_count).toBe(3)
  })

  it("prices a play at its CHEAPEST version, carrying that version's confidence", () => {
    const plays = groupChecklistByPlay(editions, true)
    const p2 = plays.find((p) => p.play_key === "1:2")!
    expect(p2.owned).toBe(false)
    expect(p2.play_cost_usd).toBe(8)
    expect(p2.fmv_confidence).toBe("LOW")
    expect(plays.find((p) => p.play_key === "1:3")!.play_cost_usd).toBeNull()
  })

  it("leaves ownership unknown (null) without a wallet", () => {
    const plays = groupChecklistByPlay(editions, false)
    for (const p of plays) {
      expect(p.owned).toBeNull()
      expect(p.owned_versions).toBeNull()
    }
  })

  it("falls back to the lowest key when the scope holds only parallels of a play", () => {
    const plays = groupChecklistByPlay([row("9:9::4"), row("9:9::2")], false)
    expect(plays).toHaveLength(1)
    expect(plays[0].route_slug).toBe("9:9::2")
  })

  it("orders missing before owned with a wallet, and is deterministic", () => {
    const plays = groupChecklistByPlay(editions, true)
    expect(plays[plays.length - 1].play_key).toBe("1:1")
    expect(groupChecklistByPlay([...editions].reverse(), true).map((p) => p.play_key)).toEqual(plays.map((p) => p.play_key))
  })

  it("is the identity grouping for a collection with no parallels", () => {
    const plain = [row("1", { floor_usd: 3 }), row("2", { floor_usd: 4 })]
    expect(groupChecklistByPlay(plain, true).map((p) => p.version_count)).toEqual([1, 1])
  })
})

describe("computePlayProgress", () => {
  const editions = [
    row("1:1", { floor_usd: 10 }),
    row("1:1::2", { floor_usd: 4, owned: true, owned_locked: true }),
    row("1:2", { floor_usd: 20, tier: "RARE" }),
    row("1:2::2", { fmv_usd: 8, tier: "RARE" }),
    row("1:3"),
  ]

  it("counts plays, not editions, and costs only the missing plays at their cheapest version", () => {
    const pr = computePlayProgress(groupChecklistByPlay(editions, true), true)
    expect(pr.total).toBe(3)
    expect(pr.owned).toBe(1)
    expect(pr.locked_owned).toBe(1)
    expect(pr.missing_count).toBe(2)
    expect(pr.completion_pct).toBe(33.3)
    // 1:1 owned via its parallel → $0 needed; 1:2 → $8 (its parallel); 1:3 → unpriced.
    expect(pr.cost_to_complete_usd).toBe(8)
    expect(pr.unpriced_missing_count).toBe(1)
  })

  it("never counts an unpriced missing play as $0 — it is reported, not summed", () => {
    const pr = computePlayProgress(groupChecklistByPlay([row("5:5"), row("5:5::1")], true), true)
    expect(pr.cost_to_complete_usd).toBe(0)
    expect(pr.unpriced_missing_count).toBe(1)
    expect(pr.stale_missing_pct).toBe(100)
  })

  it("breaks down by the standard edition's tier", () => {
    const pr = computePlayProgress(groupChecklistByPlay(editions, true), true)
    const rare = pr.by_tier.find((t) => t.tier === "RARE")!
    expect(rare).toEqual({ tier: "RARE", total: 1, owned: 0, cost_usd: 8 })
    expect(pr.by_tier[0].tier).toBe("RARE") // tier rank order: RARE before COMMON
  })

  it("without a wallet: nothing owned, full cost, locked count unknown", () => {
    const pr = computePlayProgress(groupChecklistByPlay(editions, false), false)
    expect(pr.owned).toBe(0)
    expect(pr.locked_owned).toBeNull()
    expect(pr.cost_to_complete_usd).toBe(4 + 8)
  })

  it("an empty scope has no completion percentage rather than a fabricated one", () => {
    const pr = computePlayProgress([], true)
    expect(pr.total).toBe(0)
    expect(pr.completion_pct).toBeNull()
    expect(pr.stale_missing_pct).toBeNull()
  })
})
