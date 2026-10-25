import { describe, it, expect } from "vitest"
import { shareCollectionFmvLabel } from "@/lib/share-card-view"

// 2026-10-25 live: /share/0x1b78493f9b29ceb3 showed "LALIGA GOLAZOS · 2 moments · $0"
// for two priced moments worth $0.38 — the tile rounded to whole dollars.
describe("shareCollectionFmvLabel", () => {
  it("keeps cents under $10 instead of rounding a real value to $0", () => {
    expect(shareCollectionFmvLabel(0.38, 2)).toBe("$0.38")
    expect(shareCollectionFmvLabel(9.5, 3)).toBe("$9.50")
  })
  it("rounds to whole dollars from $10 up (unchanged behaviour)", () => {
    expect(shareCollectionFmvLabel(257.32, 153)).toBe("$257")
    expect(shareCollectionFmvLabel(61621.4, 15606)).toBe("$61,621")
  })
  it("says 'not priced' for moments with no priced value, never $0", () => {
    expect(shareCollectionFmvLabel(0, 4)).toBe("not priced")
    expect(shareCollectionFmvLabel(null, 4)).toBe("not priced")
    expect(shareCollectionFmvLabel(Number.NaN, 4)).toBe("not priced")
    for (const v of [0, null, NaN]) expect(shareCollectionFmvLabel(v as number, 4)).not.toMatch(/^\$0(\.00)?$/)
  })
})
