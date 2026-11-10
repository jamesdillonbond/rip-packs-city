import { describe, expect, it } from "vitest"
import { isDealOwned, sniperOwnedEditionKeys } from "@/lib/sniper/helpers"

// 2026-11-10: the Golazos sniper read "6744 owned editions tracked" — the wallet's TOP SHOT
// count — and filtered Golazos deals by Top Shot edition keys.
describe("sniperOwnedEditionKeys", () => {
  const topShot = new Set(["218:8238", "26:504"])
  const stats = new Map([
    ["2", { owned: 1, locked: 0 }],
    ["8", { owned: 2, locked: 2 }],
    ["14", { owned: 0, locked: 0 }],
  ])

  it("Top Shot keeps its on-chain set", () => {
    expect(sniperOwnedEditionKeys("nba-top-shot", topShot, stats)).toBe(topShot)
  })

  it.each(["laliga-golazos", "nfl-all-day", "ufc", "candy-mlb"])(
    "⚠ %s never receives a Top Shot key, and counts only editions it actually holds",
    (slug) => {
      const owned = sniperOwnedEditionKeys(slug, topShot, stats)
      expect([...owned].sort()).toEqual(["2", "8"])
      for (const k of topShot) expect(owned.has(k)).toBe(false)
    },
  )

  it("an empty collection read is an empty set, not the Top Shot one", () => {
    expect(sniperOwnedEditionKeys("laliga-golazos", topShot, new Map()).size).toBe(0)
  })

  it("the board's owned test matches a deal by this collection's key", () => {
    const owned = sniperOwnedEditionKeys("laliga-golazos", topShot, stats)
    expect(isDealOwned({ editionKey: "8" } as never, owned)).toBe(true)
    expect(isDealOwned({ editionKey: "218:8238" } as never, owned)).toBe(false)
  })
})
