// __tests__/fix-inbox-index-counts.test.ts
//
// Pins `scripts/fix-inbox-index-counts.mjs` against the ONE thing it exists for:
// making INDEX.md's two count assertions re-derivable at APPLY time instead of
// frozen into a patch at authoring time. Three consecutive patch sets shipped
// counts that were correct when written and stale on arrival.
//
// ⚠ MUTATION-CHECKED, and the result is reported honestly rather than rounded up:
// run against a `fixCounts` that returns its input unchanged, **4 of the 7 go RED
// and 3 stay green** — 4 failed | 3 passed. The three survivors are the ones that
// SHOULD survive a no-op, and naming them is the point:
//
//   * "is idempotent"                    — a no-op is trivially idempotent.
//   * "touches nothing but the count tokens" — a no-op touches nothing at all.
//   * "extracts entry targets…"          — pins `linkedFilings`, which the mutant
//                                          did not replace.
//
// They are INVARIANTS (they constrain what the fixer must not do), not behaviour,
// so a no-op satisfying them is correct. ⛔ The thing to avoid is writing
// "mutation-checked" over a suite where the green ones were never distinguished —
// a survivor you have not named is indistinguishable from a vacuous assertion.

import { describe, it, expect } from "vitest"
import { fixCounts, linkedFilings } from "../scripts/fix-inbox-index-counts.mjs"

const INDEX = (headerN: number, days: Array<{ date: string; n: number; entries: number }>) =>
  [
    `# Inbox index — ${headerN} live filings`,
    "",
    "preamble that must survive untouched",
    "",
    ...days.flatMap((d) => [
      `## ${d.date} — ${d.n} ${d.n === 1 ? "filing" : "filings"}`,
      "",
      ...Array.from({ length: d.entries }, (_, i) => `- [t${i}](${d.date}T0${i}00Z-x.md) — summary`),
      "",
    ]),
  ].join("\n")

describe("fix-inbox-index-counts", () => {
  it("rewrites a stale header to the ON-DISK count, not the entry count", () => {
    // The guard compares the header against files on disk. An index that lists
    // 2 while 5 files exist must become 5 — using the entry count would write a
    // number that still fails.
    const src = INDEX(275, [{ date: "2026-08-27", n: 2, entries: 2 }])
    const { text, changes } = fixCounts(src, 5)
    expect(text).toMatch(/^# Inbox index — 5 live filings/m)
    expect(changes.join(" ")).toContain("275 -> 5")
  })

  it("rewrites each per-day heading to the entries actually under it", () => {
    const src = INDEX(3, [
      { date: "2026-08-26", n: 9, entries: 1 },
      { date: "2026-08-27", n: 1, entries: 2 },
    ])
    const { text } = fixCounts(src, 3)
    expect(text).toMatch(/^## 2026-08-26 — 1 filing$/m)
    expect(text).toMatch(/^## 2026-08-27 — 2 filings$/m)
  })

  it("uses the singular noun at exactly one, which the guard's regex allows", () => {
    const src = INDEX(1, [{ date: "2026-08-09", n: 4, entries: 1 }])
    expect(fixCounts(src, 1).text).toMatch(/^## 2026-08-09 — 1 filing$/m)
  })

  it("is idempotent — a correct file is returned byte-identical with no changes", () => {
    const src = INDEX(2, [{ date: "2026-08-27", n: 2, entries: 2 }])
    const { text, changes } = fixCounts(src, 2)
    expect(changes).toEqual([])
    expect(text).toBe(src)
  })

  it("touches nothing but the count tokens", () => {
    const src = INDEX(99, [{ date: "2026-08-27", n: 99, entries: 2 }])
    const { text } = fixCounts(src, 2)
    expect(text).toContain("preamble that must survive untouched")
    expect(text).toContain("- [t0](2026-08-27T0000Z-x.md) — summary")
    expect(text.split("\n").length).toBe(src.split("\n").length)
  })

  it("stops counting a section at the next '## ' heading of any kind", () => {
    // A non-date '## ' section between day sections must not have its bullets
    // attributed to the day above it.
    const src = [
      "# Inbox index — 1 live filings",
      "## 2026-08-27 — 5 filings",
      "- [a](2026-08-27T0100Z-a.md) — s",
      "## Why this file exists",
      "- [not a filing entry](2026-08-27T0200Z-b.md) — s",
    ].join("\n")
    const { text } = fixCounts(src, 1)
    expect(text).toMatch(/^## 2026-08-27 — 1 filing$/m)
  })

  it("extracts entry targets the same way the guard does", () => {
    const src = "- [x](2026-08-27T0100Z-a.md) — s\n- [y](./nope.md) — s\n"
    expect(linkedFilings(src)).toEqual(["2026-08-27T0100Z-a.md"])
  })
})
