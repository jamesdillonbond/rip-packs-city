import { describe, it, expect } from "vitest"
import { indexCoverageNote } from "@/lib/entity/index-coverage-note"

// The Top Collectors panel ranks holders over the ownership index, which only
// covers the sets it was built from. A partial index must SAY it is partial —
// never present partial holdings as the player's (2026-10-15).
describe("indexCoverageNote", () => {
  it("states the gap when the index covers fewer editions than the player has", () => {
    const note = indexCoverageNote({ total_editions: 26, indexed_editions: 21 }, true)
    expect(note).toContain("21")
    expect(note).toContain("26")
    expect(note).toMatch(/not included/)
  })

  it("NO-CHANGE CONTROL: full coverage adds no note", () => {
    expect(indexCoverageNote({ total_editions: 21, indexed_editions: 21 }, true)).toBeNull()
  })

  it("a failed coverage read never reads as full coverage", () => {
    const note = indexCoverageNote(null, false)
    expect(note).not.toBeNull()
    expect(note).toMatch(/Couldn.t check/)
  })

  it("an empty or malformed answer claims nothing", () => {
    expect(indexCoverageNote(null, true)).toBeNull()
    expect(indexCoverageNote({ total_editions: 0, indexed_editions: 0 }, true)).toBeNull()
    expect(indexCoverageNote({ total_editions: Number.NaN, indexed_editions: 3 }, true)).toBeNull()
  })
})
