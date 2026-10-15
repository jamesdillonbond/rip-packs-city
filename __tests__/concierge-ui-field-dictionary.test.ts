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
  // 2026-10-14: webz_80's question ("it is pinging me about a moment where
  // nothing changed") and the setting that answers it.
  it("answers 'why does my alert ping me every day' with the Notify me entry", () => {
    const hit = lookupUiField("why does my alert ping me every day for the same moment", "alerts")[0]
    expect(hit?.id).toBe("alerts.notify-mode")
    expect(hit?.meaning).toMatch(/Once per listing/)
    expect(hit?.meaning).toMatch(/no daily or weekly DIGEST/)
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

// 2026-10-11 — the pack simulator and overview fields resolve to their entries.
describe("ui field dictionary — 2026-10-11 entries", () => {
  it("answers 'what is EV per slot' on the simulator with the lower-bound entry", () => {
    const hit = lookupUiField("what does EV / slot mean, why is there a ≥", "pack rip simulator")[0]
    expect(hit?.id).toBe("pack-simulator.ev-per-slot")
    expect(hit?.meaning).toMatch(/LOWER BOUND/)
  })
  it("answers 'what is Priced from Sales' on the overview", () => {
    expect(lookupUiField("what does priced from sales mean", "collection overview")[0]?.id).toBe("overview.priced-from-sales")
  })
  it("answers 'what does the ~ after slots mean'", () => {
    expect(lookupUiField("what does the ~ next to slots / pack mean", "pack rip simulator header")[0]?.id).toBe("pack-simulator.header-stats")
  })
})
