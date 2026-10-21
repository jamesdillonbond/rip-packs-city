// __tests__/edition-title-twins-get-a-tie-break.test.ts
//
// lib/edition/title-twins.ts — editions identical on every field a title names
// get the fewest separating words: tier, then (Top Shot) mint size, then the
// edition number. Rows are REAL production `editions` rows read 2026-10-21.

import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
import { titleDisambiguator, type TwinRow } from "@/lib/edition/title-twins"
import { editionPageMetadata } from "@/lib/seo"

const row = (o: Partial<TwinRow> & { external_id: string }): TwinRow => ({
  player_name: null, team_name: null, set_name: null, play_category: null, play_type: null,
  game_date: null, circulation_count: null, tier: null, subedition_name: null, badges: [], ...o,
})
const asPayload = (r: TwinRow) => ({ ...r, route_slug: r.external_id })
const title = (p: Record<string, unknown>, c: string, tb: string | null) => {
  const t = editionPageMetadata(p, c, tb).title as unknown
  return typeof t === "string" ? t : String((t as { absolute?: string }).absolute)
}

// Golazos 293 / 350 — two plays (291 / 347) of one goal, every titled field equal.
const prats = (id: string) => row({ external_id: id, player_name: "Abdón Prats", team_name: "RCD Mallorca", set_name: "Knock Knock", play_type: "GOAL", game_date: "2023-01-07", circulation_count: 1500, tier: "UNCOMMON" })
// Top Shot Celtics Champion's Path 2024 Redemptions (team moments: no player).
const celtics = (id: string, circ: number, tier: string) => row({ external_id: id, team_name: "Boston Celtics", set_name: "The Champion's Path 2024", play_category: "Redemption", circulation_count: circ, tier })
const CELTICS = [celtics("141:5149", 4347, "FANDOM"), celtics("141:5150", 4347, "FANDOM"), celtics("141:5177", 999, "RARE")]

describe("edition title twins get a tie-break", () => {
  it("Golazos twins differ only by edition number", () => {
    const rows = [prats("293"), prats("350")]
    expect(titleDisambiguator(asPayload(rows[0]), rows, "laliga-golazos")).toBe("#293")
    expect(titleDisambiguator(asPayload(rows[1]), rows, "laliga-golazos")).toBe("#350")
    const titles = rows.map((r) => title(asPayload(r), "laliga-golazos", titleDisambiguator(asPayload(r), rows, "laliga-golazos")))
    expect(new Set(titles).size).toBe(2)
    expect(titles[1]).toContain("Knock Knock · GOAL · Jan 7, 2023 · /1500 · #350")
  })

  it("tier separates when it can; the edition number only for what tier leaves", () => {
    const d = CELTICS.map((r) => titleDisambiguator(asPayload(r), CELTICS, "nba-top-shot"))
    expect(d).toEqual(["Fandom · #141:5149", "Fandom · #141:5150", "Rare"])
    const titles = CELTICS.map((r, i) => title(asPayload(r), "nba-top-shot", d[i]))
    expect(new Set(titles).size).toBe(3)
  })

  it("Top Shot mint size separates two editions of one tier", () => {
    // 88:3341 / 88:3348 — Donovan Mitchell, The Challenge: Champion, Dunk, both FANDOM.
    const m = (id: string, c: number) => row({ external_id: id, player_name: "Donovan Mitchell", set_name: "The Challenge: Champion", play_category: "Dunk", game_date: "2022-10-30", circulation_count: c, tier: "FANDOM" })
    const rows = [m("88:3341", 105), m("88:3348", 208)]
    expect(rows.map((r) => titleDisambiguator(asPayload(r), rows, "nba-top-shot"))).toEqual(["/105", "/208"])
  })

  it("MIRROR: no sibling with the same title → no tie-break, title unchanged", () => {
    const other = prats("999")
    other.game_date = "2023-02-01"
    expect(titleDisambiguator(asPayload(prats("293")), [prats("293"), other], "laliga-golazos")).toBeNull()
    expect(title(asPayload(prats("293")), "laliga-golazos", null)).not.toContain("#")
  })

  it("MIRROR: a same-set row of another player is not a twin; Panini/Candy never get one", () => {
    const rival = { ...prats("350"), player_name: "Someone Else" }
    expect(titleDisambiguator(asPayload(prats("293")), [prats("293"), rival], "laliga-golazos")).toBeNull()
    expect(titleDisambiguator(asPayload(prats("293")), [prats("293"), prats("350")], "panini-blockchain")).toBeNull()
  })
})
