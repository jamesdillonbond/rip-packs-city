import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  parseQueued,
  newestOvernightHandoff,
  STALE_NIGHTS,
  headingsAfterNightPass,
  likelyClosedBy,
  isNightPassHeading,
} from "../scripts/report-ready-queue.mjs"

describe("isNightPassHeading", () => {
  it("recognises every night-pass heading format the ledger has used", () => {
    for (const h of [
      "### 2026-10-09 · 🟢 NIGHT PASS — 0 shipped, 0 reverted (nightly overnight, push-capable) — **Health GREEN**",
      "### 2026-10-08 · 🟢 GREEN — 0 shipped, 0 reverted (nightly overnight, push-capable via desktop-VM clone) — **Health clean**",
      "### 2026-10-03 · 📏 VERIFIED (nightly, nothing shipped) — **Quiet GREEN night**",
      "### 2026-09-26 (overnight autonomous pass, ~01:11 AM PT) · 🟢 QUEUE-ONLY, shipped 0",
      "### 2026-09-24 · 🟢 Overnight pass (~1:10 AM PT): GREEN, shipped 0",
    ]) expect(isNightPassHeading(h), h).toBe(true)
  })

  it("does not take a daytime entry that only MENTIONS the night pass for the pass", () => {
    // The two real headings that broke an earlier whole-line match on 10-09.
    for (const h of [
      "### 2026-10-09 · 🔧 SHIPPED (hook) — **Cloud sessions now print the night pass's ready queue at start**",
      "### 2026-10-09 · 🔧 SHIPPED (script) — **Bug caught: a case-insensitive `NIGHT PASS` match stopped early**",
      "### 2026-10-09 · 📝 DOCS — **Night-pass output contract: \"0 shipped\" now carries an idle reason**",
    ]) expect(isNightPassHeading(h), h).toBe(false)
  })
})

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

  describe("ledger cross-check", () => {
    const ledger = [
      "# ledger",
      "### 2026-10-09 · 🔧 SHIPPED (hook) — sessions print the night pass's ready queue",
      "### 2026-10-09 · 🗄 APPLIED — `rpc-chain-arrival-pack-pulls` UNWEDGED",
      "### 2026-10-09 · 🔎 MEASURED — #173 re-measured, NOT shipped",
      "### 2026-10-09 · 🟢 NIGHT PASS — 0 shipped (nightly overnight)",
      "### 2026-10-09 · 🗄 APPLIED — `older-lane` fixed before the pass",
      "### 2026-10-08 · 🗄 APPLIED — `chain-arrival-pack-pulls` drained",
    ].join("\n")

    it("keeps only headings written after that date's night pass", () => {
      const h = headingsAfterNightPass(ledger, "2026-10-09")
      expect(h.map((x: { line: number }) => x.line)).toEqual([2, 3, 4])
    })

    it("does not mistake a daytime entry ABOUT the night pass for the pass itself", () => {
      // Regression: a case-insensitive match stopped at line 2 and returned
      // nothing, so every item read open on the day this was written.
      expect(headingsAfterNightPass(ledger, "2026-10-09").length).toBeGreaterThan(1)
    })

    it("marks an item closed only when a later heading names it AND carries a closing status", () => {
      const h = headingsAfterNightPass(ledger, "2026-10-09")
      const lane = { n: 1, nights: 5, text: "**[P1] `chain-arrival-pack-pulls` bound**" }
      const measuredOnly = { n: 2, nights: null, text: "**[Claude Code] #173** re-key" }
      const beforePass = { n: 3, nights: 2, text: "`older-lane` thing" }
      expect(likelyClosedBy(lane, h)?.line).toBe(3)
      expect(likelyClosedBy(measuredOnly, h)).toBeNull()
      expect(likelyClosedBy(beforePass, h)).toBeNull()
    })
  })
})
