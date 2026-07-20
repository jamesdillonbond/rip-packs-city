import { describe, it, expect } from "vitest"
import {
  sortKeyToServerSort,
  duplicateGroupKey,
  computeDuplicateEditionKeys,
} from "@/lib/collection/helpers"
import type { MomentRow, SortKey } from "@/lib/collection/types"

// Unit tests for the wallet-collection viewer's server-sort mapping and the
// duplicate-detection keying, extracted from the ~1,600-line client page. A wrong
// sort mapping silently orders the grid wrong; a mismatched dedupe key makes the
// "duplicates only" filter and the dup count disagree.

const ROW_BASE = { setName: "Base Set", playerName: "Luka Doncic", parallel: null, subedition: null }

function row(over: Record<string, unknown> = {}): MomentRow {
  return { ...ROW_BASE, ...over } as unknown as MomentRow
}

describe("sortKeyToServerSort", () => {
  it("maps the four server-sortable keys with direction", () => {
    expect(sortKeyToServerSort("fmv", "asc")).toBe("fmv_asc")
    expect(sortKeyToServerSort("fmv", "desc")).toBe("fmv_desc")
    expect(sortKeyToServerSort("paid", "asc")).toBe("paid_asc")
    expect(sortKeyToServerSort("paid", "desc")).toBe("paid_desc")
  })
  it("serial is always ascending; acquired maps to 'recent'", () => {
    expect(sortKeyToServerSort("serial", "asc")).toBe("serial_asc")
    expect(sortKeyToServerSort("serial", "desc")).toBe("serial_asc")
    expect(sortKeyToServerSort("acquired", "desc")).toBe("recent")
  })
  it("client-only keys fall back to fmv (direction-aware)", () => {
    for (const k of ["player", "series", "set", "parallel", "rarity", "bestOffer", "held", "badge"] as SortKey[]) {
      expect(sortKeyToServerSort(k, "asc")).toBe("fmv_asc")
      expect(sortKeyToServerSort(k, "desc")).toBe("fmv_desc")
    }
  })
})

describe("duplicateGroupKey", () => {
  it("keys on set || player || parallel", () => {
    expect(duplicateGroupKey(row({ setName: "S", playerName: "P", parallel: "Hexwave" }))).toBe("S||P||Hexwave")
  })
  it("treats a missing set/player as empty string and falls back parallel→subedition", () => {
    expect(duplicateGroupKey(row({ setName: null, playerName: null, parallel: null, subedition: null }))).toBe("||||Base")
  })
})

describe("computeDuplicateEditionKeys", () => {
  it("returns only the keys that appear more than once", () => {
    const rows = [
      row({ setName: "A", playerName: "P1" }),
      row({ setName: "A", playerName: "P1" }), // dup of the first
      row({ setName: "B", playerName: "P2" }), // singleton
    ]
    const dups = computeDuplicateEditionKeys(rows)
    expect(dups.has("A||P1||Base")).toBe(true)
    expect(dups.has("B||P2||Base")).toBe(false)
    expect(dups.size).toBe(1)
  })
  it("different parallels of the same set+player are NOT duplicates", () => {
    const rows = [
      row({ setName: "A", playerName: "P", parallel: "Standard" }),
      row({ setName: "A", playerName: "P", parallel: "Hexwave" }),
    ]
    expect(computeDuplicateEditionKeys(rows).size).toBe(0)
  })
  it("empty rows → empty set", () => {
    expect(computeDuplicateEditionKeys([]).size).toBe(0)
  })
})
