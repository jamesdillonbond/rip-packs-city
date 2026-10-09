import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseQueued, newestOvernightHandoff, STALE_NIGHTS } from "../scripts/report-ready-queue.mjs"

describe("report-ready-queue", () => {
  it("parses only the numbered items inside the Queued section, with their night counts", () => {
    const md = [
      "## Shipped",
      "1. not queued — 9 nights",
      "## Queued for Trevor / Claude Code (not auto-shipped)",
      "",
      "1. **[P1, recurring — 5 nights] lane wedged** — off-limits",
      "   continuation line",
      "2. **[operator-gated] drop SQL**",
      "## Failed / blocked / reverted",
      "3. after the section",
    ].join("\n")
    const items = parseQueued(md)
    expect(items.map((i) => i.n)).toEqual([1, 2])
    expect(items[0].nights).toBe(5)
    expect(items[0].nights).toBeGreaterThanOrEqual(STALE_NIGHTS)
    expect(items[1].nights).toBeNull()
  })

  it("returns nothing when the section is absent (a quiet handoff is not an error)", () => {
    expect(parseQueued("## Shipped\n1. thing\n")).toEqual([])
  })

  it("reads the real 10-09 handoff that motivated it: the 5-night P1 is item 1", () => {
    // Positive control on production data, so a format drift in the handoffs
    // shows up here rather than as a silently empty queue at session start.
    const file = path.join(process.cwd(), "docs/handoff-2026-10-09-overnight-pass.md")
    const items = parseQueued(readFileSync(file, "utf8"))
    expect(items.length).toBeGreaterThanOrEqual(3)
    expect(items[0].text).toContain("chain-arrival-pack-pulls")
    expect(items[0].nights).toBe(5)
  })

  it("finds a newest overnight handoff in docs/", () => {
    const f = newestOvernightHandoff(path.join(process.cwd(), "docs"))
    expect(f).toMatch(/handoff-\d{4}-\d{2}-\d{2}-overnight-pass\.md$/)
  })
})
