// Regular-season Fast Break (2026-27) optimizer: nightly combined-stat targets.
import { describe, expect, it } from "vitest"
import {
  buildThresholdLineup,
  lineupOutlook,
  normCdf,
  usesForMoment,
  type ThresholdPlayer,
} from "@/lib/fast-break/threshold-optimizer"

function player(id: string, proj: ThresholdPlayer["proj"], extra: Partial<ThresholdPlayer> = {}): ThresholdPlayer {
  return {
    nbaPlayerId: id,
    fullName: id,
    teamAbbr: "AAA",
    proj,
    injuryStatus: "ACTIVE",
    remainingUses: 2,
    totalUses: 2,
    highestTier: "COMMON",
    bestMomentId: `m-${id}`,
    bestSerial: 100,
    gameId: "g1",
    opponentTeamAbbr: "BBB",
    ...extra,
  }
}

describe("normCdf", () => {
  it("matches the standard normal at known points", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6)
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3)
  })
})

describe("lineupOutlook", () => {
  it("weights the Captain 1.5x toward every target", () => {
    const a = player("a", { pts: 20 })
    const b = player("b", { pts: 10 })
    const none = lineupOutlook([a, b], null, { pts: 30 })
    const capA = lineupOutlook([a, b], "a", { pts: 30 })
    expect(none.targets[0].projected).toBe(30)
    expect(capA.targets[0].projected).toBe(40)
    expect(capA.probability).toBeGreaterThan(none.probability)
  })

  it("multiplies the odds across targets, so two targets are never easier than one", () => {
    const ps = [player("a", { fg3m: 4, fg3a: 9 }), player("b", { fg3m: 3, fg3a: 8 })]
    const one = lineupOutlook(ps, null, { fg3m: 6 }).probability
    const two = lineupOutlook(ps, null, { fg3m: 6, fg3a: 16 }).probability
    expect(two).toBeLessThanOrEqual(one)
  })
})

describe("buildThresholdLineup", () => {
  const targets = { reb: 40 }
  const slate = [
    player("big1", { reb: 12 }), player("big2", { reb: 11 }), player("big3", { reb: 10 }),
    player("big4", { reb: 9 }), player("big5", { reb: 8 }), player("guard", { reb: 3 }),
    player("hurt", { reb: 15 }, { injuryStatus: "OUT" }),
    player("spent", { reb: 14 }, { remainingUses: 0 }),
  ]

  it("picks the five most likely to clear the target and never an OUT or spent player", () => {
    const L = buildThresholdLineup(slate, targets)!
    const ids = L.players.map(p => p.nbaPlayerId).sort()
    expect(ids).toEqual(["big1", "big2", "big3", "big4", "big5"])
    expect(ids).not.toContain("hurt")
    expect(ids).not.toContain("spent")
    expect(L.captainNbaPlayerId).toBe("big1")
    expect(L.bench?.nbaPlayerId).toBe("guard")
    expect(L.winProbability).toBeGreaterThan(0.5)
  })

  it("returns null when fewer than five players can play — an honest 'not enough', not a short lineup", () => {
    expect(buildThresholdLineup(slate.slice(0, 4), targets)).toBeNull()
  })

  it("returns null with no targets rather than inventing an objective", () => {
    expect(buildThresholdLineup(slate, {})).toBeNull()
  })

  it("saves a scarce play when an unlimited Moment gives the same odds", () => {
    const easy = { pts: 20 }
    const ps = [
      player("a", { pts: 30 }), player("b", { pts: 30 }), player("c", { pts: 30 }), player("d", { pts: 30 }),
      player("scarce", { pts: 30 }, { remainingUses: 1, totalUses: 4 }),
      player("free", { pts: 30 }, { remainingUses: null, totalUses: null }),
    ]
    const L = buildThresholdLineup(ps, easy)!
    const ids = L.players.map(p => p.nbaPlayerId)
    expect(ids).toContain("free")
    expect(ids).not.toContain("scarce")
  })

  it("is deterministic for the same inputs", () => {
    const a = buildThresholdLineup(slate, targets)!
    const b = buildThresholdLineup(slate.slice().reverse(), targets)!
    expect(a.players.map(p => p.nbaPlayerId).sort()).toEqual(b.players.map(p => p.nbaPlayerId).sort())
    expect(a.captainNbaPlayerId).toBe(b.captainNbaPlayerId)
  })
})

describe("usesForMoment (2026-27: higher of price band and tier)", () => {
  it("applies Top Shot's price bands", () => {
    expect(usesForMoment(5, "COMMON")).toBe(1)
    expect(usesForMoment(25, "COMMON")).toBe(2)
    expect(usesForMoment(75, "COMMON")).toBe(3)
    expect(usesForMoment(500, "COMMON")).toBe(4)
    expect(usesForMoment(5000, "COMMON")).toBeNull()
  })
  it("lets the tier win when it is higher — a $9 Rare gets two, a $75 Rare three", () => {
    expect(usesForMoment(9, "RARE")).toBe(2)
    expect(usesForMoment(75, "RARE")).toBe(3)
  })
  it("treats an Ultimate as unlimited", () => {
    expect(usesForMoment(1, "ULTIMATE")).toBeNull()
  })
  it("gives a Legendary four plays — measured against Top Shot's own counts, 116/116", () => {
    expect(usesForMoment(155, "LEGENDARY")).toBe(4)
  })
  it("treats a Moment with no established average sale price as unlimited (Hall of Fame)", () => {
    expect(usesForMoment(null, "COMMON")).toBeNull()
    expect(usesForMoment(0, "RARE")).toBeNull()
  })
})
