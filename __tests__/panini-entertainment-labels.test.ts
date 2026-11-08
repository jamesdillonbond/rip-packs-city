import { describe, it, expect, vi, beforeEach } from "vitest"

// Panini Entertainment nomenclature (2026-11-08). Panini reuses its SPORTS fields for its
// entertainment lines (`team` = the IP / band, `athlete` = the figure), so the product's label
// set decides the nouns: Character / Franchise / Cast, or Artist / Band / Lineup for music; and
// every Panini card is a Card, never a Moment.

const st = vi.hoisted(() => ({
  editions: { data: [] as any, error: null as any },
  products: { data: [] as any, error: null as any },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      const b: any = {}
      for (const m of ["select", "eq", "in", "limit"]) b[m] = () => b
      b.then = (resolve: any) => resolve(t === "editions" ? st.editions : st.products)
      return b
    },
  },
}))

import { getEntityLabels } from "@/lib/entity-labels"
import { effectiveLabelSet, productSetIdOf, labelSetForProducts, paniniLabelSetFor } from "@/lib/panini/label-set"

beforeEach(() => {
  st.editions = { data: [], error: null }
  st.products = { data: [], error: null }
})

describe("getEntityLabels — Panini", () => {
  it("every Panini card is a Card, sports included", () => {
    const l = getEntityLabels("panini-blockchain")
    expect([l.unit, l.units, l.player, l.team]).toEqual(["Card", "Cards", "Player", "Team"])
  })
  it("an entertainment line speaks Pinnacle's vocabulary", () => {
    const l = getEntityLabels("panini-blockchain", "entertainment")
    expect([l.player, l.players, l.team, l.roster, l.unit]).toEqual(["Character", "Characters", "Franchise", "Cast", "Card"])
  })
  it("a band's members are Artists of a Band, never Characters", () => {
    const l = getEntityLabels("panini-blockchain", "music")
    expect([l.player, l.team, l.roster]).toEqual(["Artist", "Band", "Lineup"])
  })
  it("the label set never leaks into another collection", () => {
    expect(getEntityLabels("nba-top-shot", "music").player).toBe("Player")
    expect(getEntityLabels("nba-top-shot", "entertainment").unit).toBe("Moment")
    expect(getEntityLabels("disney-pinnacle", "music").unit).toBe("Pin")
  })
})

describe("lib/panini/label-set", () => {
  it("the registry rule: explicit label_set, else entertainment for the Entertainment grid, else sports", () => {
    expect(effectiveLabelSet({ label_set: "music", last_grid_sport: "Entertainment" })).toBe("music")
    expect(effectiveLabelSet({ label_set: null, last_grid_sport: "Entertainment" })).toBe("entertainment")
    expect(effectiveLabelSet({ label_set: null, last_grid_sport: "Basketball" })).toBe("sports")
    expect(effectiveLabelSet({ label_set: "sports", last_grid_sport: "Entertainment" })).toBe("sports")
    expect(effectiveLabelSet(null)).toBe("sports")
  })
  it("reads the product out of a Panini edition id", () => {
    expect(productSetIdOf("packcard-2130_415500_32")).toBe(2130)
    expect(productSetIdOf("packcard-850147_111937_1-1_27")).toBe(850147)
    expect(productSetIdOf("12:34")).toBeNull()
  })
  it("a page spanning products of different sets keeps the general nouns", () => {
    expect(labelSetForProducts([{ label_set: "music", last_grid_sport: null }, { label_set: "music", last_grid_sport: null }])).toBe("music")
    expect(labelSetForProducts([{ label_set: "music", last_grid_sport: null }, { label_set: null, last_grid_sport: "Football" }])).toBe("sports")
  })
  it("resolves a Rolling Stones page to music from its editions' product", async () => {
    st.editions = { data: [{ external_id: "packcard-2130_1_1" }, { external_id: "packcard-2130_2_1" }], error: null }
    st.products = { data: [{ label_set: "music", last_grid_sport: "Entertainment" }], error: null }
    expect(await paniniLabelSetFor("team_name", "The Rolling Stones")).toBe("music")
  })
  it("⚠ a failed read falls back to sports nouns and never throws", async () => {
    st.editions = { data: null, error: { message: "timeout" } }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await paniniLabelSetFor("player_name", "Shelby")).toBe("sports")
    st.editions = { data: [{ external_id: "packcard-850130_1_1" }], error: null }
    st.products = { data: null, error: { message: "boom" } }
    expect(await paniniLabelSetFor("player_name", "Shelby")).toBe("sports")
    warn.mockRestore()
  })
  it("an empty name or a name with no editions is sports", async () => {
    expect(await paniniLabelSetFor("team_name", "")).toBe("sports")
    expect(await paniniLabelSetFor("team_name", "Nobody")).toBe("sports")
  })
})
