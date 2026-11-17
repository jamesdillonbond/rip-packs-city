// 2026-09-25 — the moment page's "Similar editions" tiles are, on Top Shot, the
// play's other PARALLELS, so six tiles read identically ("Courtney Lee · RARE ·
// Series 2025-26 · Run It Back: For The Win") with only the price differing
// (seen live on /moment/52671084). The tile now names the parallel from the
// printing ladder already on the page, else the print run, so it says what it is.

import { describe, it, expect } from "vitest"
import { similarEditionParallelLabel, candyParallelFromExternalId } from "@/lib/moment-detail/similar-edition-label"

const ladder = [
  { external_id: "273:9048", subedition_name: "Standard", circulation_count: 149 },
  { external_id: "273:9048::19", subedition_name: "Hexwave", circulation_count: 25 },
  { external_id: "273:9048::22", subedition_name: "Omega", circulation_count: 1 },
  { external_id: "273:9048::17", subedition_name: "  ", circulation_count: 99 },
]

describe("similarEditionParallelLabel", () => {
  it("names the parallel and its print run when the ladder knows the edition", () => {
    expect(similarEditionParallelLabel({ external_id: "273:9048::19", circulation_count: 25 }, ladder)).toBe(" · Hexwave /25")
    expect(similarEditionParallelLabel({ external_id: "273:9048::22", circulation_count: 1 }, ladder)).toBe(" · Omega /1")
  })
  it("falls back to the print run when the ladder does not carry the edition or its name is blank", () => {
    expect(similarEditionParallelLabel({ external_id: "273:9048::21", circulation_count: 5 }, ladder)).toBe(" · /5")
    expect(similarEditionParallelLabel({ external_id: "273:9048::17", circulation_count: 99 }, ladder)).toBe(" · /99")
    expect(similarEditionParallelLabel({ external_id: null, circulation_count: 1500 }, [])).toBe(" · /1,500")
  })
  it("takes the ladder's print run when the tile has none, and says nothing when neither is known", () => {
    expect(similarEditionParallelLabel({ external_id: "273:9048::19", circulation_count: null }, ladder)).toBe(" · Hexwave /25")
    expect(similarEditionParallelLabel({ external_id: null, circulation_count: null }, ladder)).toBe("")
    expect(similarEditionParallelLabel({ circulation_count: null }, [])).toBe("")
  })
})

// Candy MLB (2026-09-25): no printing ladder, so two Rainbow Trouts rendered as
// identical "LEGENDARY · … · /15" tiles. The colour comes from the external_id;
// the slug rule was checked against all 125 live editions (25 Rainbows named,
// 100 base cards null) before shipping.
describe("candyParallelFromExternalId", () => {
  it("names a Rainbow parallel by colour", () => {
    expect(candyParallelFromExternalId("mike-trout-pink", "Mike Trout")).toBe("Pink")
    expect(candyParallelFromExternalId("bobby-witt-jr-blue", "Bobby Witt Jr.")).toBe("Blue")
  })
  it("returns null for a BASE card — never a fabricated colour", () => {
    expect(candyParallelFromExternalId("mike-trout", "Mike Trout")).toBeNull()
    expect(candyParallelFromExternalId("pete-crow-armstrong", "Pete Crow-Armstrong")).toBeNull()
    // Non-ASCII is DROPPED in Candy's slugs: the base card must still read null.
    expect(candyParallelFromExternalId("jos-ramrez", "José Ramírez")).toBeNull()
    expect(candyParallelFromExternalId("ronald-acua-jr", "Ronald Acuña Jr.")).toBeNull()
  })
  it("returns null when the id is not this player's", () => {
    expect(candyParallelFromExternalId("aaron-judge", "Mike Trout")).toBeNull()
    expect(candyParallelFromExternalId(null, "Mike Trout")).toBeNull()
  })
  it("feeds the tile label as a fallback, never over a ladder name", () => {
    expect(similarEditionParallelLabel({ external_id: "mike-trout-pink", circulation_count: 15 }, [], "Pink")).toBe(" · Pink /15")
    expect(
      similarEditionParallelLabel(
        { external_id: "x", circulation_count: 25 },
        [{ external_id: "x", subedition_name: "Ruby", circulation_count: 25 }],
        "Pink",
      ),
    ).toBe(" · Ruby /25")
  })
})
