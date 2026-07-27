import { describe, it, expect } from "vitest"
import { buildCollectionCsv, COLLECTION_CSV_HEADERS } from "@/lib/collection/export-csv"
import type { MomentRow } from "@/lib/collection/types"

// Minimal MomentRow factory — only the fields the CSV reads matter; the rest
// are cast through so the test stays focused on the export contract.
function row(over: Partial<MomentRow> = {}): MomentRow {
  return {
    momentId: "m1",
    playerName: "LeBron James",
    setName: "Base Set",
    series: "4",
    tier: "COMMON",
    parallel: null,
    subedition: null,
    serialNumber: 12,
    mintCount: 15000,
    fmv: 4.2,
    lowAsk: 5,
    bestOffer: 3.5,
    badgeInfo: { badge_titles: ["Rookie", "Championship"] } as any,
    acquiredAt: null,
    ...over,
  } as MomentRow
}

describe("buildCollectionCsv", () => {
  it("emits the header row in the stable export column order", () => {
    const csv = buildCollectionCsv([])
    // Behaviour preserved verbatim from the former inline builder:
    // `headers + "\n" + rows.join("\n")`, so empty input yields the header
    // line plus a trailing newline (header, then an empty data segment).
    expect(csv.split("\n")).toEqual([COLLECTION_CSV_HEADERS.join(","), ""])
  })

  it("quotes every cell and doubles embedded quotes (RFC-4180)", () => {
    const csv = buildCollectionCsv([row({ playerName: 'Say "Hi"', setName: "A, B" })])
    const lines = csv.split("\n")
    expect(lines).toHaveLength(2)
    // Embedded quote is doubled; comma-bearing cell stays a single field.
    expect(lines[1]).toContain('"Say ""Hi"""')
    expect(lines[1]).toContain('"A, B"')
    // 12 columns → 12 quoted cells → 11 field-separating commas outside quotes.
    expect(lines[1].startsWith('"')).toBe(true)
  })

  it("formats FMV/ask/offer to 2dp and blanks nulls without writing 'null'", () => {
    const csv = buildCollectionCsv([row({ fmv: 4.2, lowAsk: null, bestOffer: null })])
    const dataLine = csv.split("\n")[1]
    expect(dataLine).toContain('"4.20"')
    // Null money fields render as an empty quoted cell, never the string null.
    expect(dataLine).not.toContain("null")
    expect(dataLine).toContain('""') // at least one empty cell present
  })

  it("joins multiple badge titles with '; ' and tolerates missing badges", () => {
    const withBadges = buildCollectionCsv([row()]).split("\n")[1]
    expect(withBadges).toContain('"Rookie; Championship"')
    const noBadges = buildCollectionCsv([row({ badgeInfo: null as any })]).split("\n")[1]
    // Missing badgeInfo → empty cell, not a crash.
    expect(noBadges).toBeTruthy()
  })

  it("produces one data line per row", () => {
    const csv = buildCollectionCsv([row({ momentId: "a" }), row({ momentId: "b" }), row({ momentId: "c" })])
    expect(csv.split("\n")).toHaveLength(4) // header + 3
  })
})
