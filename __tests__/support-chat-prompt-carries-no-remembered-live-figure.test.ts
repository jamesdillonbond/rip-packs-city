import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import stripComments from "../scripts/lib/strip-comments.mjs"

// 2026-09-26: the Concierge system prompt told the model UFC "coverage is limited
// (only ~20% of editions have FMV)" — live, all 518 UFC editions had a current
// FMV row — and that price history was "the ONLY way to answer beyond ~4.5
// months" of FMV snapshots, a span that grows every day (~6 months by then).
// The prompt's own rule says coverage comes from the live "Live FMV coverage"
// section, NEVER from memory; this pins that the prompt source obeys it.
const SRC = stripComments(readFileSync(path.resolve(__dirname, "../app/api/support-chat/route.ts"), "utf8"))

describe("Concierge prompt carries no remembered live figure", () => {
  it("states no FMV-coverage percentage", () => {
    expect(SRC).not.toMatch(/\d+\s*%\s*of editions have FMV/i)
  })

  it("states no snapshot-history span that decays ('beyond ~N months')", () => {
    expect(SRC).not.toMatch(/beyond ~?\d+(\.\d+)?\s*months/i)
  })

  it("still points the model at the live coverage section (positive control)", () => {
    expect(SRC).toMatch(/Live FMV coverage/)
  })
})
