import { describe, expect, it } from "vitest"
import { buildContainerContents, MIN_INNER_COVERAGE_PCT } from "@/lib/pack-dist/container-contents"

// 2026-11-12 — "Rip EV on Boxes and Cases". A box / case holds packs; its panel adds up
// each inner pack's EV (open everything) and lowest ask (sell the packs sealed). Each total
// is withheld unless EVERY line answers — a partial sum reads as the box's value and is not.
const NOW = Date.parse("2026-11-12T15:00:00Z")
const fresh = "2026-11-12T14:25:00Z"
const box = [
  { inner_dist_id: "8928", inner_count: 1, source: "description" },
  { inner_dist_id: "8919", inner_count: 4, source: "description" },
]
const evs = [
  { dist_id: "8928", gross_ev: "77.78", fmv_coverage_pct: 93, edition_count: 101, snapshotted_at: fresh },
  { dist_id: "8919", gross_ev: 39.68, fmv_coverage_pct: 92, edition_count: 348, snapshotted_at: fresh },
]
const asks = [
  { dist_id: "8928", lowest_ask: 129 },
  { dist_id: "8919", lowest_ask: "44.99" },
  { dist_id: "8919", lowest_ask: 50 },
]
const titles = [
  { dist_id: "8928", title: "Rookie Debut Box Topper" },
  { dist_id: "8919", title: "Rookie Debut Collector Pack" },
]

describe("buildContainerContents", () => {
  it("sums count x EV and count x lowest ask for the Rookie Debut Box", () => {
    const c = buildContainerContents(box, evs, asks, titles, NOW)!
    expect(c.packCount).toBe(5)
    expect(c.ripEv).toBe(236.5)
    expect(c.sealedValue).toBe(308.96)
    expect(c.source).toBe("description")
    expect(c.lines.map((l) => l.title)).toEqual(["Rookie Debut Collector Pack", "Rookie Debut Box Topper"])
  })

  it("withholds the rip EV — never a partial sum — when one inner pack is under the coverage gate", () => {
    const low = evs.map((e) => (e.dist_id === "8928" ? { ...e, fmv_coverage_pct: MIN_INNER_COVERAGE_PCT - 4 } : e))
    const c = buildContainerContents(box, low, asks, titles, NOW)!
    expect(c.ripEv).toBeNull()
    expect(c.unpricedLines).toBe(1)
    expect(c.lines.find((l) => l.distId === "8928")!.evEach).toBeNull()
    // the sealed value does not depend on EV coverage
    expect(c.sealedValue).toBe(308.96)
  })

  it("withholds the rip EV when an inner EV is stale or missing", () => {
    const stale = evs.map((e) => (e.dist_id === "8919" ? { ...e, snapshotted_at: "2026-11-10T00:00:00Z" } : e))
    expect(buildContainerContents(box, stale, asks, titles, NOW)!.ripEv).toBeNull()
    expect(buildContainerContents(box, evs.slice(0, 1), asks, titles, NOW)!.ripEv).toBeNull()
  })

  it("withholds the sealed value when an inner pack has no live ask, and says which", () => {
    const c = buildContainerContents(box, evs, asks.filter((a) => a.dist_id !== "8928"), titles, NOW)!
    expect(c.sealedValue).toBeNull()
    expect(c.unlistedLines).toBe(1)
    expect(c.ripEv).toBe(236.5)
  })

  it("is null for a dist with no recipe (every ordinary pack)", () => {
    expect(buildContainerContents([], evs, asks, titles, NOW)).toBeNull()
  })

  it("an observed recipe row makes the recipe observed", () => {
    const c = buildContainerContents([{ ...box[0], source: "observed" }, box[1]], evs, asks, titles, NOW)!
    expect(c.source).toBe("observed")
  })
})
