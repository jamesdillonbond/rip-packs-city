import { describe, it, expect } from "vitest"
import { answerFor } from "@/lib/warmup/answer-for"

// 2026-11-14 (packs review): the Packs board rendered `data` while a new filter loaded (and after
// it failed) — the previous filter's packs under the new chip.
describe("answerFor", () => {
  it("returns the data only when it answers the current key", () => {
    expect(answerFor({ rows: [1] }, "k:legendary", "k:legendary")).toEqual({ rows: [1] })
  })
  it("the previous key's data is NOT an answer to the new key", () => {
    expect(answerFor({ rows: [1] }, "k:all", "k:legendary")).toBeNull()
  })
  it("no data, or no key yet, is no answer", () => {
    expect(answerFor(null, "k", "k")).toBeNull()
    expect(answerFor({ rows: [] }, null, "k")).toBeNull()
  })
})
