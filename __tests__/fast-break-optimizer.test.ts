import { describe, it, expect } from "vitest"
import {
  buildOptimalLineup,
  findAcquisitionGap,
  suggestCaptainAlternates,
  type ProjectedPlayer,
  type EligiblePlayer,
} from "@/lib/fast-break-optimizer"

function mkPlayer(over: Partial<ProjectedPlayer> & { id: string }): ProjectedPlayer {
  return {
    nbaPlayerId: over.id,
    fullName: over.fullName ?? `Player ${over.id}`,
    teamAbbr: over.teamAbbr ?? "POR",
    highestTier: over.highestTier ?? "COMMON",
    remainingUses: over.remainingUses ?? 5,
    bestMomentId: over.bestMomentId ?? `m-${over.id}`,
    bestSerial: over.bestSerial ?? 100,
    projPoints: over.projPoints ?? 30,
    projMinutes: over.projMinutes ?? 30,
    injuryStatus: over.injuryStatus ?? null,
    gameId: over.gameId ?? "g1",
    opponentTeamAbbr: over.opponentTeamAbbr ?? "LAL",
  }
}

describe("buildOptimalLineup", () => {
  it("picks the highest projected score when serial sums are unequal at top", () => {
    const players = [
      mkPlayer({ id: "a", projPoints: 50, bestSerial: 1000 }),
      mkPlayer({ id: "b", projPoints: 45, bestSerial: 1000 }),
      mkPlayer({ id: "c", projPoints: 30, bestSerial: 1 }),
    ]
    const lineup = buildOptimalLineup(players, 2, false)
    expect(lineup).not.toBeNull()
    const ids = lineup!.players.map(p => p.nbaPlayerId).sort()
    expect(ids).toEqual(["a", "b"])
  })

  it("breaks ties on serial sum: equal score, lower serial wins", () => {
    // Two combinations both project to 80 points.
    // Combo A: players p1(40, serial=1000) + p2(40, serial=1000) -> sum 2000
    // Combo B: players p3(40, serial=1) + p4(40, serial=2) -> sum 3
    // Both within 5% of best (which is 80). Lower serial sum wins: Combo B.
    const players = [
      mkPlayer({ id: "p1", projPoints: 40, bestSerial: 1000 }),
      mkPlayer({ id: "p2", projPoints: 40, bestSerial: 1000 }),
      mkPlayer({ id: "p3", projPoints: 40, bestSerial: 1 }),
      mkPlayer({ id: "p4", projPoints: 40, bestSerial: 2 }),
    ]
    const lineup = buildOptimalLineup(players, 2, false)
    expect(lineup).not.toBeNull()
    expect(lineup!.serialSum).toBe(3)
    const ids = lineup!.players.map(p => p.nbaPlayerId).sort()
    expect(ids).toEqual(["p3", "p4"])
  })

  it("excludes players whose injuryStatus is OUT", () => {
    const players = [
      mkPlayer({ id: "in1", projPoints: 50 }),
      mkPlayer({ id: "out", projPoints: 80, injuryStatus: "OUT" }),
      mkPlayer({ id: "in2", projPoints: 40 }),
    ]
    const lineup = buildOptimalLineup(players, 2, false)
    expect(lineup).not.toBeNull()
    const ids = lineup!.players.map(p => p.nbaPlayerId).sort()
    expect(ids).toEqual(["in1", "in2"])
  })

  it("excludes players with zero remainingUses", () => {
    const players = [
      mkPlayer({ id: "ok1", projPoints: 30 }),
      mkPlayer({ id: "burnt", projPoints: 80, remainingUses: 0 }),
      mkPlayer({ id: "ok2", projPoints: 25 }),
    ]
    const lineup = buildOptimalLineup(players, 2, false)
    expect(lineup).not.toBeNull()
    const ids = lineup!.players.map(p => p.nbaPlayerId).sort()
    expect(ids).toEqual(["ok1", "ok2"])
  })

  it("respects lineup size 2 vs 3", () => {
    const players = [
      mkPlayer({ id: "a", projPoints: 40 }),
      mkPlayer({ id: "b", projPoints: 35 }),
      mkPlayer({ id: "c", projPoints: 30 }),
      mkPlayer({ id: "d", projPoints: 25 }),
    ]
    const two = buildOptimalLineup(players, 2, false)
    const three = buildOptimalLineup(players, 3, false)
    expect(two?.players.length).toBe(2)
    expect(three?.players.length).toBe(3)
  })

  it("flags Captain as the highest-projected player in the chosen lineup", () => {
    const players = [
      mkPlayer({ id: "low", projPoints: 30 }),
      mkPlayer({ id: "mid", projPoints: 40 }),
      mkPlayer({ id: "top", projPoints: 50 }),
    ]
    const lineup = buildOptimalLineup(players, 3, true)
    expect(lineup?.captainNbaPlayerId).toBe("top")
  })

  it("returns null when fewer eligible players than lineupSize", () => {
    const players = [mkPlayer({ id: "lonely", projPoints: 50 })]
    const lineup = buildOptimalLineup(players, 3, false)
    expect(lineup).toBeNull()
  })

  it("does not set Captain when hasCaptain is false", () => {
    const players = [
      mkPlayer({ id: "a", projPoints: 40 }),
      mkPlayer({ id: "b", projPoints: 35 }),
    ]
    const lineup = buildOptimalLineup(players, 2, false)
    expect(lineup?.captainNbaPlayerId).toBeNull()
  })
})

describe("suggestCaptainAlternates", () => {
  it("orders by variance proxy descending (higher minutes => higher variance)", () => {
    const players = [
      mkPlayer({ id: "low-min", projPoints: 40, projMinutes: 2 }),
      mkPlayer({ id: "high-min", projPoints: 40, projMinutes: 36 }),
    ]
    const lineup = buildOptimalLineup(players, 2, true)!
    const sorted = suggestCaptainAlternates(lineup)
    expect(sorted[0].nbaPlayerId).toBe("high-min")
  })
})

describe("findAcquisitionGap", () => {
  it("returns players the user does not own with remainingUses > 0", () => {
    const want = ["a", "b", "c", "d"]
    const have: EligiblePlayer[] = [
      {
        nbaPlayerId: "a",
        fullName: "A",
        teamAbbr: "X",
        highestTier: "COMMON",
        remainingUses: 1,
        bestMomentId: "m1",
        bestSerial: 1,
      },
      {
        nbaPlayerId: "b",
        fullName: "B",
        teamAbbr: "X",
        highestTier: "COMMON",
        remainingUses: 0,
        bestMomentId: "m2",
        bestSerial: 1,
      },
    ]
    const gap = findAcquisitionGap(want, have)
    expect(gap.sort()).toEqual(["b", "c", "d"])
  })
})
