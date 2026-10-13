import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  parseQueued,
  newestOvernightHandoff,
  STALE_NIGHTS,
  headingsAfterNightPass,
  likelyClosedBy,
  isNightPassHeading,
  headingsBeforeNightPass,
  findQueueSection,
  itemKeys,
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

// 2026-10-11: the 10-11 handoff titled its section "## Needs your decision /
// QUEUED" and wrote its carried P1/P2/P3 as `- ` bullets. The exact-heading
// parser read that as an EMPTY queue ("nothing queued"), so three items closed
// on 10-09 were carried a second night with nothing flagging them.
describe("report-ready-queue — drifted handoffs and re-carried items", () => {
  it("finds every queue heading the handoffs have used, but not a RESOLVED recap", () => {
    for (const h of [
      "## Queued for Trevor / Claude Code (not auto-shipped)",
      "## Needs your decision / QUEUED",
      "## 5. Needs Trevor / queued",
      "## Queued / needs Trevor (carried forward, unchanged)",
    ]) expect(findQueueSection(["# x", h]), h).toBe(1)
    expect(findQueueSection(["## Previous night pass — both queued items now RESOLVED"])).toBe(-1)
  })

  it("reads top-level bullets as items, and not indented continuation bullets", () => {
    const md = [
      "## Needs your decision / QUEUED",
      "1. **`lane_one` thing**",
      "**Still queued from prior nights:**",
      "- **chain-arrival-pack-pulls durable BOUND (P1, ~7 nights)** — spec",
      "  - indented detail, not an item",
      "- **#173 conflated bases** — Claude Code",
      "## Failed",
      "- after the section",
    ].join("\n")
    const items = parseQueued(md)
    expect(items.map((i) => i.n)).toEqual([1, 2, 3])
    expect(items[1].nights).toBe(7)
    expect(itemKeys(items[1].text)).toContain("chain-arrival-pack-pulls")
  })

  it("an absent section is distinguishable from an empty one", () => {
    expect(findQueueSection("## Shipped\n1. x".split("\n"))).toBe(-1)
    expect(parseQueued("## Queued for Trevor\n\nnothing\n")).toEqual([])
    expect(findQueueSection("## Queued for Trevor\n\nnothing\n".split("\n"))).toBe(0)
  })

  it("takes #NNN keys from the item TITLE only, and ignores 4-char backtick tokens", () => {
    const k = itemKeys("**`get_wallet_pack_summary` 8 s timeout** — carries `#187` box-model edits; on `main`")
    expect(k).toContain("get_wallet_pack_summary")
    expect(k).not.toContain("#187")
    expect(itemKeys("**#23 / #25** — not on `main`")).toEqual(["#23", "#25"])
  })

  describe("closed BEFORE the pass, then re-carried", () => {
    const ledger = [
      "# ledger",
      "### 2026-10-11 · 🔧 FIXED — **`after-lane` fixed after the pass**",
      "### 2026-10-11 · 🟢 GREEN NIGHT — 0 shipped (nightly autonomous pass) — carried `old-lane-p1` VERIFIED",
      "### 2026-10-10 · ✅ CLOSED (verified live) — **`old-lane-p1` was fixed on 10-09 but carried**",
      "### 2026-10-10 · 🔧 SHIPPED — **#187 closed** — body mentions `get_wallet_pack_summary` in passing",
      "### 2026-10-09 · 🗄 APPLIED — no bold, body names `another-old-lane` in passing",
      "### 2026-09-20 · ✅ CLOSED — **`ancient-lane-x` closed** (outside the 14-day window)",
    ].join("\n")
    const before = headingsBeforeNightPass(ledger, "2026-10-11")

    it("keeps headings below the pass, inside the window, with a bold claim, and never the pass itself", () => {
      expect(before.map((x: { line: number }) => x.line)).toEqual([4, 5])
    })

    it("closes a re-carried item; does not close one a heading only mentions in its body", () => {
      expect(likelyClosedBy({ n: 1, nights: 7, text: "**old-lane-p1 bound (P1, ~7 nights)**" }, before)?.line).toBe(4)
      expect(likelyClosedBy({ n: 2, nights: null, text: "**`get_wallet_pack_summary` timeout**" }, before)).toBeNull()
      expect(likelyClosedBy({ n: 3, nights: null, text: "**`another-old-lane` x**" }, before)).toBeNull()
      expect(likelyClosedBy({ n: 4, nights: null, text: "**`ancient-lane-x` x**" }, before)).toBeNull()
    })
  })

  it("positive control on the real 10-11 handoff: its queue is NOT read as empty", () => {
    const file = path.join(process.cwd(), "docs/handoff-2026-10-11-overnight-pass.md")
    const items = parseQueued(readFileSync(file, "utf8"))
    expect(items.length).toBeGreaterThanOrEqual(8)
    expect(items.some((i) => i.text.includes("chain-arrival-pack-pulls"))).toBe(true)
  })
})

// 2026-10-13: the 10-13 handoff titled its section "## Carried queue (needs a
// non-night-pass owner)" — no "queued" — so the reporter printed "no section
// found" and the morning session started with no carried queue. 09-28 and 10-03
// ("## Needs Trevor (carried…)") had been read as absent the same way.
describe("report-ready-queue — 'carried' headings", () => {
  it("finds a section titled with 'carried' in any of the three spellings used", () => {
    for (const h of [
      "## Carried queue (needs a non-night-pass owner)",
      "## Needs Trevor (carried, unchanged)",
      "## Needs Trevor (carried)",
    ]) expect(findQueueSection(["# x", h]), h).toBe(1)
  })

  it("does not take a QUEUE-ONLY mode heading that sits above the real section", () => {
    const lines = ["## Mode — OFF-HOURS / QUEUE-ONLY (nothing shipped, by design)", "x", "## Needs Trevor (all QUEUED — nothing here is a ship)"]
    expect(findQueueSection(lines)).toBe(2)
  })

  it("does not take a 'closed … dropped from carry' recap for the queue", () => {
    expect(findQueueSection(["## Verified closed this pass (dropped from carry)"])).toBe(-1)
    const lines = ["## Carried queue (needs a non-night-pass owner)", "1. a", "## Verified closed this pass (dropped from carry)", "- b"]
    expect(findQueueSection(lines)).toBe(0)
  })

  it("positive control on the real 10-13 handoff: its four carried items are read", () => {
    const file = path.join(process.cwd(), "docs/handoff-2026-10-13-overnight-pass.md")
    const items = parseQueued(readFileSync(file, "utf8"))
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4])
    expect(items[0].text).toContain("OPENSEA_API_KEY")
    // the "Verified closed" section below it is NOT swallowed into the queue
    expect(items.some((i) => i.text.includes("topshot_offers_history_backfill"))).toBe(false)
  })

  it("every overnight handoff in docs/ resolves to a queue section (no silent absence)", () => {
    const files = readdirSync(path.join(process.cwd(), "docs")).filter((f) => /^handoff-.*overnight.*\.md$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(17)
    const unmatched = files.filter(
      (f) => findQueueSection(readFileSync(path.join(process.cwd(), "docs", f), "utf8").split(/\r?\n/)) < 0,
    )
    expect(unmatched).toEqual([])
  })
})
