import { describe, it, expect } from "vitest"
import { completeDaysOnly } from "@/lib/insights/market-index-board"

describe("completeDaysOnly — the market index never headlines a day still in progress", () => {
  const rows = [
    { d: "2026-11-22", tier: "OPEN" },
    { d: "2026-11-23", tier: "OPEN" },
    { d: "2026-11-24", tier: "OPEN" }, // the UTC day in progress at 5 PM PT on 11-23: one $33 sale
  ]
  it("drops today's UTC day and anything later", () => {
    expect(completeDaysOnly(rows, "2026-11-24").map((r) => r.d)).toEqual(["2026-11-22", "2026-11-23"])
    expect(completeDaysOnly(rows, "2026-11-23").map((r) => r.d)).toEqual(["2026-11-22"])
  })
  it("keeps every complete day and tolerates a timestamp-shaped d", () => {
    expect(completeDaysOnly([{ d: "2026-11-23T00:00:00Z" }], "2026-11-24")).toHaveLength(1)
    expect(completeDaysOnly([], "2026-11-24")).toEqual([])
  })
})
