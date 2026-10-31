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

// 2026-10-25 — a replay of real questions against production: the concierge said
// squeeze ignores stacking and that the squeeze board has no team filter, then
// logged both as new requests. The board has carried "Top 5 hold" and a TEAM box
// since 10-03, built from that same tester's requests.
describe("ui field dictionary — squeeze board (2026-10-25 replay)", () => {
  it("the stacking question reaches the Top 5 hold entry", () => {
    const hits = lookupUiField(
      "does the squeeze calculation take into account users stacking the moment. ie. if there are 500 editions but one user is stacking 200 of them",
      "squeeze (insights)",
    )
    expect(hits.map((h) => h.id)).toContain("squeeze-board.top5-hold")
    const top5 = hits.find((h) => h.id === "squeeze-board.top5-hold")!
    expect(top5.meaning).toMatch(/5 largest COLLECTOR wallets/)
    expect(top5.meaning).toMatch(/never 0%/)
  })
  it("the squeeze % entry itself points at the stacking column, so either hit answers it", () => {
    const pct = lookupUiField("what does the squeeze % mean on a team page", "team (nba-top-shot)")[0]
    expect(pct?.id).toBe("squeeze.pct")
    expect(pct?.meaning).toMatch(/does NOT count stacking/)
    expect(pct?.meaning).toMatch(/Top 5 hold/)
  })
  // Re-pinned 2026-10-30: the PLAYER box shipped (beta feedback 11684), so the entry
  // now names BOTH typed boxes instead of calling the player filter drill-down only.
  it("the filter question reaches the filters entry, which names the TEAM and PLAYER boxes", () => {
    const hit = lookupUiField("can we have a player and team filter on the squeeze page as well?", "squeeze (insights)")[0]
    expect(hit?.id).toBe("squeeze-board.filters")
    expect(hit?.meaning).toMatch(/TEAM, a typed box/)
    expect(hit?.meaning).toMatch(/PLAYER, a typed box/)
    expect(hit?.meaning).not.toMatch(/no typed player box/)
  })
  it("the NBA / WNBA toggle question reaches the filters entry, which names LEAGUE (webz_80, 2026-10-27)", () => {
    const hit = lookupUiField("have a toggle to switch between nba and wnba so i can only see nba moments", "squeeze (insights)")[0]
    expect(hit?.id).toBe("squeeze-board.filters")
    expect(hit?.meaning).toMatch(/LEAGUE \(Top Shot only: ALL \/ NBA \/ WNBA/)
  })
  it("the trophy-circ question reaches the filters entry, which says MAX MINT caps the minted count, never reduced by burns", () => {
    const hit = lookupUiField("what does trophy-circ mean, is it the original mint count before burns?", "squeeze (insights)")[0]
    expect(hit?.id).toBe("squeeze-board.filters")
    expect(hit?.meaning).toMatch(/MAX MINT/)
    expect(hit?.meaning).toMatch(/locks and burns never reduce/)
  })
  it("the player-checklist ask (webz_80, 2026-10-27) reaches the shipped entry and names the player page", () => {
    const hit = lookupUiField("in addition to team checklists, a player checklist might be a fun addition", "team (nba-top-shot)")[0]
    expect(hit?.id).toBe("player-checklist")
    expect(hit?.meaning).toMatch(/player page/)
    expect(hit?.meaning).toMatch(/owned vs missing/)
  })
  it("the 1/1 crowding complaint reaches MIN MINT", () => {
    const hit = lookupUiField("everything at the top is ultimates and 1/1 rare parallels, maybe have a minimum circulation filter", "squeeze (insights)")[0]
    expect(hit?.id).toBe("squeeze-board.filters")
    expect(hit?.meaning).toMatch(/MIN MINT/)
  })
})
