import { describe, it, expect } from "vitest"
import { sortPlayerEditionsByFmv } from "@/lib/concierge/player-editions-order"

const rows = [{ k: "mid", fmv_usd: 5 }, { k: "none", fmv_usd: null }, { k: "top", fmv_usd: "40" }, { k: "low", fmv_usd: 0.5 }]

describe("sortPlayerEditionsByFmv", () => {
  it("descending puts the most valuable first and the unpriced last", () => {
    expect(sortPlayerEditionsByFmv(rows, false).map((r) => r.k)).toEqual(["top", "mid", "low", "none"])
  })
  it("ascending puts the CHEAPEST PRICED edition first — never the unpriced one", () => {
    expect(sortPlayerEditionsByFmv(rows, true).map((r) => r.k)).toEqual(["low", "mid", "top", "none"])
  })
  it("does not reorder the caller's array", () => {
    const copy = [...rows]
    sortPlayerEditionsByFmv(rows, true)
    expect(rows).toEqual(copy)
  })
})
