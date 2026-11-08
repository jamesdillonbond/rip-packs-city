import { describe, it, expect } from "vitest"
import {
  dealBalanced,
  dealByMode,
  isDealMode,
  manifestOf,
  rankByValue,
  sealPoolDealt,
  simulatePackSpread,
  valueBands,
  verifyCommitment,
  type PoolMoment,
} from "@/lib/giveaways/seal"
import { DEFAULT_FILTER, filterCandidates, previewPack, randomFill, shapesFor, tierLabel, tierMix, tiersOf, type BuilderCandidate } from "@/lib/giveaways/pool-builder"
import { packTotal, tierKey } from "@/lib/giveaways/reveal"

// A skewed pool: 4 packs of 3, two big hits, a tail of commons.
const POOL: PoolMoment[] = [
  { moment_id: "1", fmv_usd: 200 },
  { moment_id: "2", fmv_usd: 150 },
  { moment_id: "3", fmv_usd: 20 },
  { moment_id: "4", fmv_usd: 18 },
  { moment_id: "5", fmv_usd: 9 },
  { moment_id: "6", fmv_usd: 8 },
  { moment_id: "7", fmv_usd: 7 },
  { moment_id: "8", fmv_usd: 6 },
  { moment_id: "9", fmv_usd: 2 },
  { moment_id: "10", fmv_usd: 1.5 },
  { moment_id: "11", fmv_usd: 1 },
  { moment_id: "12", fmv_usd: 0.5 },
]

/** The property the database enforces (seal_giveaway_drop_dealt): slot k holds exactly band k. */
function bandsHold(assignments: { moment_id: string; pack_no: number; slot: number }[], pool: PoolMoment[], packs: number): boolean {
  const ranked = rankByValue(pool)
  return assignments.every((a) => Math.floor(ranked.findIndex((m) => m.moment_id === a.moment_id) / packs) + 1 === a.slot)
}

describe("giveaways — the balanced deal", () => {
  it("every pack gets exactly one moment from each value band, slot k = band k", () => {
    for (let i = 0; i < 50; i++) {
      const a = dealBalanced(POOL, 4, 3)
      expect(a).toHaveLength(12)
      expect(new Set(a.map((x) => `${x.pack_no}.${x.slot}`)).size).toBe(12)
      expect(bandsHold(a, POOL, 4)).toBe(true)
      // the two big hits can never share a pack
      const p1 = a.find((x) => x.moment_id === "1")!.pack_no
      const p2 = a.find((x) => x.moment_id === "2")!.pack_no
      expect(p1).not.toBe(p2)
    }
  })

  it("a stacked deal fails the band property the database checks (planted)", () => {
    const stacked = POOL.map((m, i) => ({ moment_id: m.moment_id, pack_no: Math.floor(i / 3) + 1, slot: (i % 3) + 1 }))
    expect(bandsHold(stacked, POOL, 4)).toBe(false)
  })

  it("which pack gets which band member is the injected RNG's choice (shuffle within the band)", () => {
    const first = dealBalanced(POOL, 4, 3, () => 0)
    const last = dealBalanced(POOL, 4, 3, (max) => max - 1)
    expect(manifestOf(first)).not.toBe(manifestOf(last))
    expect(bandsHold(first, POOL, 4) && bandsHold(last, POOL, 4)).toBe(true)
  })

  it("ranks ties by moment id in code-point order, as Postgres COLLATE \"C\" does", () => {
    const tied = [
      { moment_id: "99", fmv_usd: 5 },
      { moment_id: "100", fmv_usd: 5 },
      { moment_id: "7", fmv_usd: 6 },
    ]
    expect(rankByValue(tied).map((m) => m.moment_id)).toEqual(["7", "100", "99"])
  })

  it("refuses an unpriced moment, a wrong-sized pool and a duplicate", () => {
    expect(() => dealBalanced([...POOL.slice(0, 11), { moment_id: "12", fmv_usd: null }], 4, 3)).toThrow(/priced/)
    expect(() => dealBalanced(POOL.slice(0, 11), 4, 3)).toThrow(/need 12/)
    expect(() => dealBalanced([...POOL.slice(0, 11), { moment_id: "1", fmv_usd: 1 }], 4, 3)).toThrow(/duplicate/)
  })

  it("random mode is the v1 whole-pool shuffle; both modes seal to a verifiable commitment", () => {
    const r = dealByMode(POOL, 4, 3, "random", () => 0)
    expect(r).toHaveLength(12)
    for (const mode of ["random", "balanced"] as const) {
      const s = sealPoolDealt(POOL, 4, 3, mode, { salt: "ab".repeat(32) })
      expect(verifyCommitment(s.salt, manifestOf(s.assignments), s.hash)).toBe(true)
    }
    expect(isDealMode("balanced") && isDealMode("random")).toBe(true)
    expect(isDealMode("fair") || isDealMode(undefined)).toBe(false)
  })

  it("the spread preview: balanced packs land closer together than random ones on a skewed pool", () => {
    const fmvs = POOL.map((m) => m.fmv_usd)
    let seed = 7
    const lcg = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const random = simulatePackSpread(fmvs, 4, 3, "random", 300, lcg)!
    const balanced = simulatePackSpread(fmvs, 4, 3, "balanced", 300, lcg)!
    expect(balanced.worst_high_usd - balanced.worst_low_usd).toBeLessThan(random.worst_high_usd - random.worst_low_usd)
    // balanced can never put both hits in one pack: its best pack is below 200 + 150
    expect(balanced.worst_high_usd).toBeLessThan(350)
    expect(simulatePackSpread([...fmvs.slice(0, 11), null], 4, 3, "balanced")).toBeNull()
    expect(simulatePackSpread(fmvs, 5, 3, "random")).toBeNull()
  })
})

describe("giveaways — pool builder helpers", () => {
  const C: BuilderCandidate[] = [
    { moment_id: "1", player_name: "Damian Lillard", set_name: "Base", team_name: "Portland Trail Blazers", tier: "RARE", serial_number: 7, fmv_usd: 20 },
    { moment_id: "2", player_name: "Anfernee Simons", set_name: "Base", team_name: "Portland Trail Blazers", tier: "COMMON", serial_number: 900, fmv_usd: 2 },
    { moment_id: "3", player_name: "Luka Doncic", set_name: "Holo Icon", team_name: "Los Angeles Lakers", tier: "LEGENDARY", serial_number: 12, fmv_usd: 400 },
    { moment_id: "4", player_name: null, set_name: null, team_name: null, tier: null, serial_number: null, fmv_usd: null },
  ]

  it("filters by text over player/set/team, by tier, and hides unpriced on request", () => {
    expect(filterCandidates(C, { ...DEFAULT_FILTER, q: "blazers" }).map((c) => c.moment_id)).toEqual(["1", "2"])
    expect(filterCandidates(C, { ...DEFAULT_FILTER, q: "holo" }).map((c) => c.moment_id)).toEqual(["3"])
    expect(filterCandidates(C, { ...DEFAULT_FILTER, tier: "Rare" }).map((c) => c.moment_id)).toEqual(["1"])
    expect(filterCandidates(C, { ...DEFAULT_FILTER, pricedOnly: true }).map((c) => c.moment_id)).toEqual(["3", "1", "2"])
    // default shows the unpriced one (sealing refuses it, and the builder says so) — last under FMV high → low
    expect(filterCandidates(C, DEFAULT_FILTER).map((c) => c.moment_id)).toEqual(["3", "1", "2", "4"])
  })

  it("sorts four ways without mutating its input", () => {
    const before = C.map((c) => c.moment_id)
    expect(filterCandidates(C, { ...DEFAULT_FILTER, sort: "fmv_asc" }).map((c) => c.moment_id)).toEqual(["2", "1", "3", "4"])
    expect(filterCandidates(C, { ...DEFAULT_FILTER, sort: "player" }).map((c) => c.moment_id)).toEqual(["2", "1", "3", "4"])
    expect(filterCandidates(C, { ...DEFAULT_FILTER, sort: "serial" }).map((c) => c.moment_id)).toEqual(["1", "3", "2", "4"])
    expect(C.map((c) => c.moment_id)).toEqual(before)
  })

  it("tiers read the same however the source cased them, in collector order, unknown last", () => {
    expect(tierLabel("LEGENDARY")).toBe("Legendary")
    expect(tierLabel(null)).toBe("Unknown")
    expect(tiersOf(C)).toEqual(["Common", "Rare", "Legendary", "Unknown"])
    expect(tierMix(C, new Set(["1", "3", "4"]))).toEqual([
      { tier: "Rare", count: 1 },
      { tier: "Legendary", count: 1 },
      { tier: "Unknown", count: 1 },
    ])
  })

  it("random fill tops up to the target from what is shown, never removing or repeating a pick", () => {
    const filled = randomFill(C, new Set(["1"]), 3, () => 0)
    expect(filled.size).toBe(3)
    expect(filled.has("1")).toBe(true)
    expect(randomFill(C, new Set(["1"]), 10).size).toBe(4) // can't exceed what is shown
    expect(randomFill(C, new Set(["1", "2"]), 1).size).toBe(2) // never removes
  })

  it("pack shapes that use exactly n moments, within the drop limits", () => {
    expect(shapesFor(6)).toEqual([
      { packs: 6, perPack: 1 },
      { packs: 3, perPack: 2 },
      { packs: 2, perPack: 3 },
      { packs: 1, perPack: 6 },
    ])
    expect(shapesFor(202).some((s) => s.packs > 100)).toBe(false)
  })
})

describe("giveaways — reveal helpers", () => {
  it("tierKey maps a tier to the style key, unknown as common", () => {
    expect(tierKey("ULTIMATE")).toBe("ultimate")
    expect(tierKey("Legendary")).toBe("legendary")
    expect(tierKey(null)).toBe("common")
    expect(tierKey("Champion")).toBe("common")
  })
  it("packTotal sums a fully priced pack and refuses a pack with a hole in it", () => {
    expect(packTotal([{ moment_id: "1", fmv_usd: 1.1 }, { moment_id: "2", fmv_usd: 2.2 }])).toBe(3.3)
    expect(packTotal([{ moment_id: "1", fmv_usd: 1 }, { moment_id: "2", fmv_usd: null }])).toBeNull()
    expect(packTotal([])).toBeNull()
  })
})

describe("giveaways — previewPack (admin Preview opening)", () => {
  it("a sealed drop previews one of its real packs; a draft draws perPack at random from the pool", () => {
    const sealed = [
      { moment_id: "1", pack_no: 2 },
      { moment_id: "2", pack_no: 1 },
      { moment_id: "3", pack_no: 2 },
      { moment_id: "4", pack_no: 1 },
    ]
    expect(previewPack(sealed, 2, () => 1)).toEqual({ packNo: 2, moments: [sealed[0], sealed[2]] })
    expect(previewPack(sealed, 2, () => 0).packNo).toBe(1)
    const draft = sealed.map((m) => ({ ...m, pack_no: null }))
    const pick = previewPack(draft, 3, () => 0)
    expect(pick.packNo).toBeNull()
    expect(pick.moments.map((m) => m.moment_id)).toEqual(["1", "2", "3"])
    expect(previewPack([], 3).moments).toEqual([])
  })
})

describe("giveaways — valueBands (public page, balanced drops)", () => {
  it("cuts the ranked pool into perPack bands of packCount — the same bands the database checks", () => {
    const bands = valueBands(POOL, 4, 3)!
    expect(bands.map((b) => b.map((m) => m.moment_id))).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6", "7", "8"],
      ["9", "10", "11", "12"],
    ])
    // and every sealed balanced deal puts slot k in band k
    const a = dealBalanced(POOL, 4, 3)
    for (const x of a) expect(bands[x.slot - 1].some((m) => m.moment_id === x.moment_id)).toBe(true)
    expect(valueBands(POOL.slice(0, 11), 4, 3)).toBeNull()
  })
})
