import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  placeholderFpFromPosition,
  normalizePlayerNameJs,
  normalizeConfidence,
  mapInjuryStatus,
  deriveGameStatus,
  findGameForTeam,
  parseRatingString,
  dkFantasyFromBaseStats,
} from "@/supabase/functions/_shared/nba-projections-parse"

// Pins sync-nba-projections' parse/transform core — player resolution key,
// CHECK-constrained confidence gate, ESPN rating parse, DK fantasy formula. A
// regression in any of these silently corrupts nba_player_projections, which the
// /nba/fast-break optimizer reads.

describe("placeholderFpFromPosition — roster-stub fallback FP", () => {
  it.each([
    ["C", 22],
    ["PF", 18],
    ["SG", 20],
    ["F-C", 22], // C wins the ordered checks
    [null, 12],
    ["", 12],
    ["X", 12],
  ])("pos %s → %i", (pos, fp) => {
    expect(placeholderFpFromPosition(pos as string | null)).toBe(fp)
  })
})

describe("normalizePlayerNameJs — the player-resolution key", () => {
  it("unaccents, strips non-alpha, lowercases", () => {
    expect(normalizePlayerNameJs("Luka Dončić")).toBe("lukadoncic")
    expect(normalizePlayerNameJs("Nikola Jokić")).toBe("nikolajokic")
    expect(normalizePlayerNameJs("Alperen Şengün")).toBe("alperensengun")
  })
  it("strips punctuation, digits, and spaces", () => {
    expect(normalizePlayerNameJs("D'Angelo Russell Jr. 3")).toBe("dangelorusselljr")
  })
})

describe("normalizeConfidence — the CHECK gate (MED, not MEDIUM)", () => {
  it("passes the three valid values through", () => {
    expect(normalizeConfidence("HIGH")).toBe("HIGH")
    expect(normalizeConfidence("MED")).toBe("MED")
    expect(normalizeConfidence("LOW")).toBe("LOW")
  })
  it("maps MEDIUM → MED (the exact footgun that would abort the batch)", () => {
    expect(normalizeConfidence("MEDIUM")).toBe("MED")
    expect(normalizeConfidence("medium")).toBe("MED")
  })
  it("is case/whitespace insensitive", () => {
    expect(normalizeConfidence("  high ")).toBe("HIGH")
  })
  it("null/undefined → null", () => {
    expect(normalizeConfidence(null)).toBeNull()
    expect(normalizeConfidence(undefined)).toBeNull()
  })
  it("an unknown value → null (never poisons the batch)", () => {
    expect(normalizeConfidence("VERY_HIGH")).toBeNull()
    expect(normalizeConfidence(42)).toBeNull()
  })
})

describe("mapInjuryStatus", () => {
  it.each([
    [null, "ACTIVE"],
    ["", "ACTIVE"],
    ["probable", "ACTIVE"],
    ["available", "ACTIVE"],
    ["GTD", "QUESTIONABLE"],
    ["q", "QUESTIONABLE"],
    ["Questionable", "QUESTIONABLE"],
    ["OUT", "OUT"],
    ["injured", "OUT"],
    ["ofs", "OUT"],
    ["something-weird", "ACTIVE"], // default
  ])("%s → %s", (raw, out) => {
    expect(mapInjuryStatus(raw as string | null)).toBe(out)
  })
})

describe("deriveGameStatus — tip-off relative to now (nowMs injected)", () => {
  const tip = "2026-07-26T23:00:00Z"
  const tipMs = Date.parse(tip)
  const H = 60 * 60 * 1000
  it("more than 4h past tip → final", () => {
    expect(deriveGameStatus(tip, tipMs + 5 * H)).toBe("final")
  })
  it("within ±4h of tip → live", () => {
    expect(deriveGameStatus(tip, tipMs + 2 * H)).toBe("live")
    expect(deriveGameStatus(tip, tipMs - 2 * H)).toBe("live")
  })
  it("more than 4h before tip → scheduled", () => {
    expect(deriveGameStatus(tip, tipMs - 5 * H)).toBe("scheduled")
  })
  it("exactly 4h before → live (>= boundary is inclusive)", () => {
    expect(deriveGameStatus(tip, tipMs - 4 * H)).toBe("live")
  })
  it("missing/unparseable start → scheduled", () => {
    expect(deriveGameStatus(null, tipMs)).toBe("scheduled")
    expect(deriveGameStatus("not a date", tipMs)).toBe("scheduled")
  })
})

describe("findGameForTeam — team abbr → game + opponent", () => {
  const games = [
    { gameId: "g1", homeAbbr: "LAL", awayAbbr: "BOS" },
    { gameId: "g2", homeAbbr: "MIN", awayAbbr: "DEN" },
  ]
  it("matches home team, opponent = away", () => {
    expect(findGameForTeam(games, "LAL")).toEqual({ gameId: "g1", opponentAbbr: "BOS" })
  })
  it("matches away team, opponent = home", () => {
    expect(findGameForTeam(games, "den")).toEqual({ gameId: "g2", opponentAbbr: "MIN" })
  })
  it("case/space insensitive", () => {
    expect(findGameForTeam(games, "  bos ")).toEqual({ gameId: "g1", opponentAbbr: "LAL" })
  })
  it("no match / null abbr → null", () => {
    expect(findGameForTeam(games, "GSW")).toBeNull()
    expect(findGameForTeam(games, null)).toBeNull()
  })
})

describe("parseRatingString — ESPN rating display → base stats", () => {
  it("parses a full PPG/RPG/APG/SPG/BPG line", () => {
    expect(parseRatingString("23.9 PPG, 5.5 RPG, 9.9 APG, 1.4 SPG, 0.8 BPG")).toEqual({
      pts: 23.9,
      reb: 5.5,
      ast: 9.9,
      stl: 1.4,
      blk: 0.8,
    })
  })
  it("treats a dropped stat as 0", () => {
    expect(parseRatingString("30.0 PPG, 8.0 RPG")).toEqual({
      pts: 30,
      reb: 8,
      ast: 0,
      stl: 0,
      blk: 0,
    })
  })
  it("returns null when pts+reb+ast are all 0 (empty category, not a 0-stat player)", () => {
    expect(parseRatingString("1.0 SPG, 0.5 BPG")).toBeNull()
  })
  it("empty/absent string → null", () => {
    expect(parseRatingString("")).toBeNull()
  })
})

describe("dkFantasyFromBaseStats — approximate DK fantasy points", () => {
  it("applies pts + 1.2reb + 1.5ast + 3stl + 3blk, 2dp", () => {
    // 23.9 + 1.2*5.5 + 1.5*9.9 + 3*1.4 + 3*0.8 = 23.9 + 6.6 + 14.85 + 4.2 + 2.4 = 51.95
    expect(dkFantasyFromBaseStats({ pts: 23.9, reb: 5.5, ast: 9.9, stl: 1.4, blk: 0.8 })).toBe(51.95)
  })
  it("rounds to 2 decimals", () => {
    expect(dkFantasyFromBaseStats({ pts: 10.111, reb: 0, ast: 0, stl: 0, blk: 0 })).toBe(10.11)
  })
})

describe("edge-fn source-drift guard — sync-nba-projections inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/sync-nba-projections/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/nba-projections-parse/.test(edgeSrc)

  // ASCII-only canonical expressions (avoids the combining-mark line so the guard
  // is copy-safe). Import-or-inline pattern.
  const CONF = norm('s === "MED" || s === "MEDIUM"')
  const DK = norm("s.pts + 1.2 * s.reb + 1.5 * s.ast + 3 * s.stl + 3 * s.blk")
  const PPG = norm("grab(/([\\d.]+)\\s*PPG/i)")
  const FOURHR = norm("const fourHr = 4 * 60 * 60 * 1000")

  it.each([
    ["confidence MED/MEDIUM gate", CONF],
    ["DK fantasy formula", DK],
    ["ESPN PPG grab", PPG],
    ["4h game-status window", FOURHR],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
