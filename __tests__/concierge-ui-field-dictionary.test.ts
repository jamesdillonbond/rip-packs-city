import { describe, it, expect } from "vitest"
import { lookupUiField, UI_FIELD_DICTIONARY } from "@/lib/concierge/ui-field-dictionary"

// explain_ui_field (2026-10-03): the questions real testers asked, matched to
// the entry that answers them — and a question nothing documents returns [].

describe("lookupUiField", () => {
  it("answers the tester's '+62.00 in the top right' with the add-cost badge entry", () => {
    const hits = lookupUiField("what does the $ value number represent on moment cards in the top right? it shows +62.00", "team (nba-top-shot)")
    expect(hits[0]?.id).toBe("team-checklist.add-cost-badge")
  })
  it("answers 'what does the colour of the FMV mean' with the confidence entry", () => {
    const hits = lookupUiField("why is the FMV a different colour — what does the color of the fmv mean", "edition (nba-top-shot)")
    expect(hits[0]?.id).toBe("fmv.confidence")
  })
  it("answers 'DEALS AFTER FEES' with the sniper entry", () => {
    expect(lookupUiField("what is the DEALS AFTER FEES toggle", "sniper")[0]?.id).toBe("sniper.after-fees")
  })
  it("returns nothing for a field that is not documented", () => {
    expect(lookupUiField("zxqv flibber wobble", null)).toEqual([])
  })
  it("every entry names a source file and has at least two aliases", () => {
    for (const e of UI_FIELD_DICTIONARY) {
      expect(e.source.length).toBeGreaterThan(10)
      expect(e.aliases.length).toBeGreaterThanOrEqual(2)
    }
    expect(new Set(UI_FIELD_DICTIONARY.map((e) => e.id)).size).toBe(UI_FIELD_DICTIONARY.length)
  })
})
