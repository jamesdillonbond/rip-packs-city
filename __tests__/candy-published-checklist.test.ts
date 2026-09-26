import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { CANDY_PUBLISHED_CHECKLIST_PLAYERS } from "@/lib/chains/solana/candy-checklist"

// The published-checklist constant must equal the player column of the recorded
// checklist CSV — a hand-kept list beside a source file goes stale silently.
describe("CANDY_PUBLISHED_CHECKLIST_PLAYERS mirrors the recorded checklist", () => {
  it("equals the CSV's Player column, in order", () => {
    const lines = readFileSync("docs/reference/candy-base-series-checklist-2026-07.csv", "utf8").split(/\r?\n/)
    const hdr = lines.findIndex((l) => l.startsWith("Player,"))
    expect(hdr).toBeGreaterThan(-1)
    const fromCsv = lines.slice(hdr + 1).map((l) => l.split(",")[0].trim()).filter(Boolean)
    expect(fromCsv.length).toBeGreaterThanOrEqual(100)
    expect([...CANDY_PUBLISHED_CHECKLIST_PLAYERS]).toEqual(fromCsv)
  })
})
