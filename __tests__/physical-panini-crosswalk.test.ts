import { describe, it, expect } from "vitest"
import {
  parsePhysicalProduct,
  printRunOf,
  cardNumberOf,
  judgeCandidate,
  matchPaperCard,
  compareDigitalPaper,
  type PaperKey,
  type FeedCard,
} from "@/lib/physical/panini-crosswalk"

// Panini digital -> paper matcher (prototype, unwired). Locks: every hard field
// must agree, two survivors stay ambiguous, print-run mismatches are flagged,
// and an unpriced side never yields a comparison.

const gold: PaperKey = {
  physicalProduct: "2024-25 Panini Prizm Basketball",
  subset: "Base",
  parallel: "Gold",
  digitalMintCap: 10,
  playerName: "Victor Wembanyama",
}
const card = (id: string, name: string, extra: Partial<FeedCard> = {}): FeedCard => ({
  id,
  name,
  year: 2024,
  setName: "2024-25 Panini Prizm Basketball",
  playerName: "Victor Wembanyama",
  ...extra,
})

describe("parsePhysicalProduct", () => {
  it("reads season, start year and program", () => {
    expect(parsePhysicalProduct("2024-25 Panini Prizm Basketball")).toEqual({ season: "2024-25", startYear: 2024, program: "Prizm" })
    expect(parsePhysicalProduct("2022 Panini Donruss Optic Football")?.program).toBe("Donruss Optic")
    expect(parsePhysicalProduct("2022 Panini Donruss Soccer")?.program).toBe("Donruss")
    expect(parsePhysicalProduct("2023 Panini Best of The NBA")).toBeNull()
  })
})

describe("printRunOf", () => {
  it("parses /N and 1/1", () => {
    expect(printRunOf("Wembanyama Gold Prizm /10")).toBe(10)
    expect(printRunOf("Wembanyama Black Prizm 1/1")).toBe(1)
    expect(printRunOf("Wembanyama #/49 Orange")).toBe(49)
    expect(printRunOf("Wembanyama Silver Prizm")).toBeNull()
  })
})

describe("cardNumberOf", () => {
  it("reads #N but never a #/N print run", () => {
    expect(cardNumberOf("2023-24 Prizm #136 Victor Wembanyama")).toBe("136")
    expect(cardNumberOf("Wembanyama Gold #/10")).toBeNull()
    expect(cardNumberOf("Wembanyama Gold /10")).toBeNull()
  })
})

describe("judgeCandidate", () => {
  it("accepts the exact paper card and flags a matching print run", () => {
    const v = judgeCandidate(gold, card("1", "2024-25 Prizm #136 Victor Wembanyama Gold Prizm /10"))
    expect(v).toMatchObject({ accept: true, printRunMatch: true })
  })

  it("rejects another season, program, player or parallel", () => {
    expect(judgeCandidate(gold, card("2", "Victor Wembanyama Gold Prizm /10", { year: 2023, setName: "2023-24 Panini Prizm Basketball" })).reasons).toContain("year")
    expect(judgeCandidate(gold, card("3", "Victor Wembanyama Gold /10", { setName: "2024-25 Panini Donruss Optic Basketball" })).accept).toBe(false)
    expect(judgeCandidate(gold, card("4", "Gold Prizm /10", { playerName: "Bronny James" })).reasons).toContain("player")
    expect(judgeCandidate(gold, card("5", "Victor Wembanyama Silver Prizm")).accept).toBe(false)
  })

  it("accepts the season's second year as the feed year", () => {
    expect(judgeCandidate(gold, card("6", "Victor Wembanyama Gold Prizm /10", { year: 2025 })).accept).toBe(true)
  })

  it("keeps Select's 'Silver Prizm' parallels on a Select key", () => {
    const sel: PaperKey = { physicalProduct: "2024 Panini Select Football", subset: "Base", parallel: "Silver", digitalMintCap: 250, playerName: "Jayden Daniels" }
    const v = judgeCandidate(sel, card("7", "2024 Select Concourse Jayden Daniels Silver Prizm", { setName: "2024 Panini Select Football", playerName: "Jayden Daniels" }))
    expect(v.accept).toBe(true)
    expect(v.printRunMatch).toBeNull()
  })

  it("rejects Donruss Optic for a Donruss key", () => {
    const d: PaperKey = { physicalProduct: "2023-24 Panini Donruss Soccer", subset: "Base", parallel: "Base", digitalMintCap: 999, playerName: "Jude Bellingham" }
    expect(judgeCandidate(d, card("8", "Jude Bellingham", { year: 2023, setName: "2023-24 Panini Donruss Optic Soccer", playerName: "Jude Bellingham" })).accept).toBe(false)
  })

  it("flags a print run that differs between digital and paper", () => {
    const v = judgeCandidate({ ...gold, digitalMintCap: 25 }, card("9", "Victor Wembanyama Gold Prizm /10"))
    expect(v).toMatchObject({ accept: true, printRunMatch: false })
  })

  it("never matches a digital base card to a numbered paper parallel", () => {
    const base: PaperKey = { ...gold, parallel: "Base", digitalMintCap: 999 }
    expect(judgeCandidate(base, card("10", "Victor Wembanyama Gold Prizm /10")).accept).toBe(false)
  })

  it("separates two paper cards of one player by card number", () => {
    const clark: PaperKey = { physicalProduct: "2024 Panini Prizm WNBA", subset: "Base", parallel: "Silver", digitalMintCap: 372, playerName: "Caitlin Clark", cardNumber: "22" }
    const c22 = card("22", "2024 Prizm WNBA #22 Caitlin Clark Silver Prizm", { setName: "2024 Panini Prizm WNBA", playerName: "Caitlin Clark" })
    const c145 = card("145", "2024 Prizm WNBA #145 Caitlin Clark Silver Prizm", { setName: "2024 Panini Prizm WNBA", playerName: "Caitlin Clark" })
    expect(matchPaperCard(clark, [c22, c145])).toEqual({ status: "matched", cardId: "22", printRunMatch: null })
    // Without the number both survive: ambiguous, never a pick.
    expect(matchPaperCard({ ...clark, cardNumber: null }, [c22, c145]).status).toBe("ambiguous")
    // A structured feed number beats the title.
    expect(judgeCandidate(clark, { ...c145, name: "Caitlin Clark Silver Prizm", cardNumber: "145" }).reasons).toContain("card number")
  })

  it("folds accents and drops suffixes in names", () => {
    const k: PaperKey = { ...gold, playerName: "Luka Dončić" }
    expect(judgeCandidate(k, card("11", "Luka Doncic Gold Prizm /10", { playerName: null })).accept).toBe(true)
  })
})

describe("matchPaperCard", () => {
  it("matches exactly one survivor", () => {
    const r = matchPaperCard(gold, [card("1", "Victor Wembanyama Gold Prizm /10"), card("2", "Victor Wembanyama Silver Prizm")])
    expect(r).toEqual({ status: "matched", cardId: "1", printRunMatch: true })
  })

  it("stays ambiguous with two survivors (no tie-break)", () => {
    const r = matchPaperCard(gold, [card("1", "Victor Wembanyama Gold Prizm /10"), card("2", "Victor Wembanyama Gold Prizm /10 RC")])
    expect(r).toEqual({ status: "ambiguous", cardIds: ["1", "2"] })
  })

  it("reports none with the reasons", () => {
    const r = matchPaperCard(gold, [card("1", "Victor Wembanyama Silver Prizm")])
    expect(r.status).toBe("none")
  })
})

describe("compareDigitalPaper", () => {
  it("returns a ratio only when both sides are priced", () => {
    expect(compareDigitalPaper(50, 200)).toEqual({ ratio: 0.25, premiumPct: -75 })
    expect(compareDigitalPaper(null, 200)).toBeNull()
    expect(compareDigitalPaper(50, 0)).toBeNull()
  })
})
