import { describe, it, expect } from "vitest"
import {
  flowtyTraitsToPinnacleEdition,
  pinnacleStudioShort,
  pinnacleVariantDisplay,
  PINNACLE_STUDIOS,
} from "@/lib/pinnacle/pinnacleTypes"

// flowtyTraitsToPinnacleEdition is the ONLY place raw Flowty trait strings
// become a typed Pinnacle edition, so every default in it is a value that ends
// up on a collector's pin card. The traits arrive as stringified arrays
// ("[Grogu]", "[Lucasfilm Ltd., Star Wars]") and every field is optional, so the
// interesting behaviour is entirely in the fallbacks: a missing character must
// read "Unknown" rather than "undefined", editionType decides is_serialized, and
// the minting timestamp arrives in SECONDS from some rows and MILLISECONDS from
// others — reading a seconds value as ms dates a 2024 pin to 1970.

const t = (name: string, value: string) => ({ name, value })

describe("flowtyTraitsToPinnacleEdition", () => {
  it("maps a fully-populated trait set, taking the first element of each array", () => {
    const ed = flowtyTraitsToPinnacleEdition([
      t("Characters", "[Grogu, Din Djarin]"),
      t("Franchises", "[Star Wars, Mandalorian]"),
      t("Studios", "[Lucasfilm Ltd.]"),
      t("Materials", "[Enamel, Metal]"),
      t("Effects", "[Glitter]"),
      t("RoyaltyCodes", "[SWM001]"),
      t("SetName", "Mandalorian Series 1"),
      t("SeriesName", "2024"),
      t("Variant", "Golden"),
      t("Printing", "3"),
      t("EditionType", "Limited Edition"),
      t("IsChaser", "true"),
      t("Size", "Large"),
      t("Color", "Gold"),
      t("Thickness", "Thick"),
    ])

    expect(ed).toMatchObject({
      characterName: "Grogu",
      franchise: "Star Wars",
      studio: "Lucasfilm Ltd.",
      setName: "Mandalorian Series 1",
      royaltyCode: "SWM001",
      seriesYear: 2024,
      variantType: "Golden",
      editionType: "Limited Edition",
      printing: 3,
      isChaser: true,
      isSerialized: true,
      size: "Large",
      color: "Gold",
      thickness: "Thick",
    })
    expect(ed.materials).toEqual(["Enamel", "Metal"])
    expect(ed.effects).toEqual(["Glitter"])
    // The edition key is built from the same three fields the DB keys on.
    expect(ed.editionKey).toBe("SWM001:Golden:3")
  })

  it("fills honest defaults for an empty trait set rather than undefined", () => {
    const ed = flowtyTraitsToPinnacleEdition([])
    expect(ed).toMatchObject({
      characterName: "Unknown",
      franchise: "Unknown",
      studio: "Unknown",
      setName: "",
      royaltyCode: "",
      seriesYear: null,
      variantType: "Standard",
      editionType: "Open Edition",
      printing: 1,
      isChaser: false,
      isSerialized: false,
      size: null,
      color: null,
      thickness: null,
      mintingDate: null,
    })
    expect(ed.editionKey).toBe(":Standard:1")
  })

  it("derives isSerialized from editionType, not from a separate flag", () => {
    expect(flowtyTraitsToPinnacleEdition([t("EditionType", "Open Edition")]).isSerialized).toBe(false)
    expect(flowtyTraitsToPinnacleEdition([t("EditionType", "Limited Edition")]).isSerialized).toBe(true)
  })

  it("treats any IsChaser value other than the literal 'true' as false", () => {
    expect(flowtyTraitsToPinnacleEdition([t("IsChaser", "TRUE")]).isChaser).toBe(false)
    expect(flowtyTraitsToPinnacleEdition([t("IsChaser", "1")]).isChaser).toBe(false)
    expect(flowtyTraitsToPinnacleEdition([t("IsChaser", "true")]).isChaser).toBe(true)
  })

  it("accepts a minting timestamp in EITHER seconds or milliseconds", () => {
    const seconds = 1_714_000_000 // 2024-04-24T…
    const ms = seconds * 1000
    const fromSeconds = flowtyTraitsToPinnacleEdition([t("MintingDate", String(seconds))]).mintingDate
    const fromMs = flowtyTraitsToPinnacleEdition([t("MintingDate", String(ms))]).mintingDate
    expect(fromSeconds).toBe(fromMs)
    // A seconds value read as ms would land in 1970 — the regression this pins.
    expect(fromSeconds!.startsWith("2024")).toBe(true)
  })

  it("leaves mintingDate null for a non-numeric or zero timestamp", () => {
    expect(flowtyTraitsToPinnacleEdition([t("MintingDate", "not-a-number")]).mintingDate).toBeNull()
    expect(flowtyTraitsToPinnacleEdition([t("MintingDate", "0")]).mintingDate).toBeNull()
  })

  it("nulls a non-numeric series year instead of writing NaN", () => {
    expect(flowtyTraitsToPinnacleEdition([t("SeriesName", "Series One")]).seriesYear).toBeNull()
    expect(flowtyTraitsToPinnacleEdition([t("SeriesName", "0")]).seriesYear).toBeNull()
  })

  it("survives an unparseable printing by falling back to 1", () => {
    // parseInt("") is NaN; the key must not become "X:Standard:NaN".
    const ed = flowtyTraitsToPinnacleEdition([t("RoyaltyCodes", "[X]"), t("Printing", "2")])
    expect(ed.printing).toBe(2)
    expect(ed.editionKey).toBe("X:Standard:2")
  })
})

describe("pinnacleStudioShort / pinnacleVariantDisplay", () => {
  it("shortens every known studio and passes an unknown one through untouched", () => {
    for (const studio of PINNACLE_STUDIOS) {
      expect(pinnacleStudioShort(studio)).toBeTruthy()
    }
    expect(pinnacleStudioShort("Some New Studio")).toBe("Some New Studio")
  })

  it("returns label/shortLabel/color/rank for a known variant", () => {
    const d = pinnacleVariantDisplay("Standard")
    expect(d.label).toBe("Standard")
    expect(d.shortLabel).toBeTruthy()
    expect(d.color).toMatch(/^#/)
    expect(typeof d.rank).toBe("number")
  })

  it("falls back to a 3-letter uppercase abbreviation and a neutral colour for an unknown variant", () => {
    const d = pinnacleVariantDisplay("Holographic")
    expect(d.shortLabel).toBe("HOL")
    expect(d.color).toBe("#6B7280")
    expect(d.rank).toBe(0)
  })
})
