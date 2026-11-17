import { describe, it, expect } from "vitest"
import { parseRichBlocks } from "@/lib/concierge/rich-text"

// 2026-10-24: the bubble rendered "## Heading" and "| a | b |" as raw text.
describe("parseRichBlocks — the reply's structure, never markup", () => {
  it("reads a pipe table with its header and drops the separator row", () => {
    const b = parseRichBlocks("Intro\n\n| Pack | EV |\n|---|---|\n| Gold Rush | $6.51 |\n| Heat Check | $10.55 |\n\nAfter")
    expect(b.map((x) => x.type)).toEqual(["para", "table", "para"])
    const t = b[1] as Extract<ReturnType<typeof parseRichBlocks>[number], { type: "table" }>
    expect(t.header).toEqual(["Pack", "EV"])
    expect(t.rows).toEqual([["Gold Rush", "$6.51"], ["Heat Check", "$10.55"]])
    // The separator never survives as a row of dashes.
    expect(JSON.stringify(b)).not.toContain("---")
  })

  it("reads headings, rules and bullet / numbered lists", () => {
    const b = parseRichBlocks("## Current season\n---\n- one\n- two\n  wrapped\n1. a\n2. b")
    expect(b).toEqual([
      { type: "heading", text: "Current season" },
      { type: "rule" },
      { type: "list", ordered: false, items: ["one", "two wrapped"] },
      { type: "list", ordered: true, items: ["a", "b"] },
    ])
  })

  it("leaves a line with a lone pipe as prose (no separator row = no table)", () => {
    const b = parseRichBlocks("| not a table |\nstill prose")
    expect(b).toEqual([{ type: "para", text: "| not a table |\nstill prose" }])
  })

  it("keeps a dollar figure that starts a sentence as prose, not a list", () => {
    expect(parseRichBlocks("$5 is the floor.")).toEqual([{ type: "para", text: "$5 is the floor." }])
  })
})
