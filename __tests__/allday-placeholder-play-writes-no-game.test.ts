// 2026-11-25 — Dapper mints some All Day plays before the play exists. Their chain metadata is a
// placeholder that is never updated: Trevor Lawrence play 4181 read 2025-09-07 "Jaguars vs
// Jaguars" on chain; the real play is Week 2 @ Bengals, 2025-09-14. 2024 Rookie Debut / Marquee
// placeholders read "Invalid date" and a game the player's team is not in. The edition builders
// must write NO game for such a play, never the filler — a published false date/opponent is the
// defect, an empty one is honest.
import { describe, expect, it } from "vitest"
import {
  allDayPlayIsPlaceholder,
  buildOnChainEditionRow,
  GET_EDITION_DATA_SCRIPT,
} from "@/lib/chains/flow/allday-edition-onchain"

const base = {
  playerName: "Trevor Lawrence",
  setName: "Base",
  teamName: "Jacksonville Jaguars",
  tier: "COMMON",
  seriesID: "9",
  setID: "2",
  playID: "4181",
  maxMintSize: "7500",
  numMinted: "6995",
  playType: "",
}

describe("allDayPlayIsPlaceholder", () => {
  it("flags the 2025 'key play added during the upcoming season' text", () => {
    expect(
      allDayPlayIsPlaceholder({
        ...base,
        playDescription:
          "This Base Set Moment will have a key play added during the upcoming 2025-26 season, featuring Trevor Lawrence of the Jacksonville Jaguars.",
        homeTeamName: "Jacksonville Jaguars",
        awayTeamName: "Jacksonville Jaguars",
      }),
    ).toBe(true)
  })
  it("flags the 2024 rookie 'a play will be added' text", () => {
    expect(
      allDayPlayIsPlaceholder({
        ...base,
        teamName: "Denver Broncos",
        playDescription: "Broncos rookie quarterback Bo Nix was a first-round pick… Once he makes an impact this season, a play will be added to this Moment.",
      }),
    ).toBe(true)
  })
  it("does not flag a real play that merely says 'upcoming postseason'", () => {
    expect(
      allDayPlayIsPlaceholder({
        ...base,
        teamName: "San Francisco 49ers",
        homeTeamName: "Indianapolis Colts",
        awayTeamName: "San Francisco 49ers",
        playDescription: "Of all the ways to show how prepared San Francisco was for the upcoming postseason, Brock Purdy picked…",
      }),
    ).toBe(false)
  })
  it("flags one team on both sides even without the text", () => {
    expect(allDayPlayIsPlaceholder({ ...base, homeTeamName: "Jacksonville Jaguars", awayTeamName: "Jacksonville Jaguars" })).toBe(true)
  })
  it("flags a game the player's team is not in (the 2024 Rookie placeholder)", () => {
    expect(
      allDayPlayIsPlaceholder({ ...base, teamName: "Chicago Bears", homeTeamName: "New England Patriots", awayTeamName: "Indianapolis Colts" }),
    ).toBe(true)
  })
  it("passes a real game", () => {
    expect(
      allDayPlayIsPlaceholder({
        ...base,
        playDescription: "Lawrence dropped back to pass and fired one over the middle…",
        homeTeamName: "Miami Dolphins",
        awayTeamName: "Jacksonville Jaguars",
      }),
    ).toBe(false)
  })
})

describe("buildOnChainEditionRow on a placeholder play", () => {
  it("writes no game date and no teams — never the filler", () => {
    const row = buildOnChainEditionRow(
      "4361",
      {
        ...base,
        dateOfMoment: "2025-09-07",
        homeTeamName: "Jacksonville Jaguars",
        awayTeamName: "Jacksonville Jaguars",
        playDescription: "This Base Set Moment will have a key play added during the upcoming 2025-26 season",
      },
      "2026-11-25T00:00:00Z",
    )
    expect(row.game_date).toBeNull()
    expect(row.home_team).toBeNull()
    expect(row.away_team).toBeNull()
    expect(row.team_name).toBe("Jacksonville Jaguars")
  })
  it("still writes a real game", () => {
    const row = buildOnChainEditionRow(
      "3205",
      { ...base, dateOfMoment: "09/08/2024", homeTeamName: "Miami Dolphins", awayTeamName: "Jacksonville Jaguars", playDescription: "Jacksonville fell in Miami, 20-17" },
      "2026-11-25T00:00:00Z",
    )
    expect(row.game_date).toBe("2024-09-08")
    expect(row.home_team).toBe("Miami Dolphins")
    expect(row.away_team).toBe("Jacksonville Jaguars")
  })
  it("the chain script reads the play description it needs", () => {
    expect(GET_EDITION_DATA_SCRIPT).toMatch(/result\["playDescription"\] = meta\["description"\]/)
  })
})
