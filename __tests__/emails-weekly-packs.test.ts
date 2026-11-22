import { describe, it, expect } from "vitest"
import { buildWeeklyPacksBlock, minusDays, packWeekFrom } from "@/lib/emails/weekly-packs"

// Weekly email "Sealed packs" block (2026-11-22). Pins: no value -> no block (never $0);
// the weekly change only when the snapshot exactly 7 days earlier has a pack value.

describe("packWeekFrom", () => {
  it("is null when no snapshot carries a pack value, or none are held", () => {
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: null, pack_held_count: null }])).toBeNull()
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: 0, pack_held_count: 0 }])).toBeNull()
  })
  it("takes the latest value and the one 7 days before it", () => {
    expect(packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "27966.94", pack_held_count: 2155 },
      { snapshot_date: "2026-11-23", pack_low_ask_usd: 1, pack_held_count: 1 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "27000", pack_held_count: 2150 },
    ])).toEqual({ lowAskUsd: 27966.94, held: 2155, priorUsd: 27000 })
  })
  it("no prior row 7 days back -> no change figure", () => {
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: 25533.7, pack_held_count: 327 }]))
      .toEqual({ lowAskUsd: 25533.7, held: 327, priorUsd: null })
  })
  it("minusDays crosses a month in UTC", () => {
    expect(minusDays("2026-12-03", 7)).toBe("2026-11-26")
  })
})

describe("buildWeeklyPacksBlock", () => {
  it("omits the block with no value", () => {
    expect(buildWeeklyPacksBlock(null)).toEqual({ html: "", text: [] })
  })
  it("prints the value, the pack count, and the change when known", () => {
    const b = buildWeeklyPacksBlock({ lowAskUsd: 27966.94, held: 2155, priorUsd: 27000 })
    expect(b.html).toContain("$27,966.94")
    expect(b.html).toContain("2,155 sealed packs")
    expect(b.html).toContain("not in the value above")
    expect(b.text).toContain("Up $966.94 this week")
    const first = buildWeeklyPacksBlock({ lowAskUsd: 2.39, held: 1, priorUsd: null })
    expect(first.html).not.toContain("this week")
    expect(first.text.join(" ")).toContain("1 sealed pack at the lowest live ask")
  })
})
