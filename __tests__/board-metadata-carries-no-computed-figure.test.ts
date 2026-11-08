import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// ── A computed statistic in static metadata goes stale the day it is written
//
// WHY THIS EXISTS (2026-11-08). The first-mint board's og:description said
// "Average: 15.8×. Max: 248×." — figures computed once and pasted into layout.tsx.
// The live board read 10.4× / 200.7× that day. pack-reality had the same defect on
// 09-26 ("Over 145,000 rips", "~41% delivered nothing", both false) and was fixed by
// hand with a comment, which only someone already in that file reads. The X calendar
// (docs/social/x-calendar.md) links these pages daily, so every unfurl outside X
// (Discord, Slack, iMessage read og:description) would have published the stale number.
//
// Static metadata is emitted before any row is known, so a statistic there cannot be
// right for long. The ban targets the SHAPES a board statistic takes — a multiplier
// (15.8×), a percentage (41%), a large count (145,000) — not dollar thresholds that
// describe a bucket ("a $100+ pull"), which are definitions, not measurements.
//
// Reads string LITERALS (same extractor as board-metadata-makes-no-freshness-claim),
// so the comment above documenting the fix cannot trip it.

const ROOT = path.resolve(__dirname, "..")

const COMPUTED_FIGURE: RegExp[] = [
  /\d(?:\.\d+)?\s*[×x](?![a-z])/i, // a multiplier: 15.8×, 248x
  /\d(?:\.\d+)?\s*%/, // a share: 41%, 31.6 %
  /\b\d{1,3}(?:,\d{3})+\b/, // a large count: 145,000
]

function walk(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const full = path.join(dir, e)
    if (statSync(full).isDirectory()) out = out.concat(walk(full))
    else if (e === "layout.tsx") out.push(full)
  }
  return out
}

function descriptions(src: string): string[] {
  const out: string[] = []
  const re = /\bdescription\s*:\s*(?:\r?\n\s*)?(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[2])
  return out
}

const LAYOUTS = walk(path.join(ROOT, "app", "insights"))

describe("insights board metadata carries no computed figure", () => {
  it("is not vacuous: the walk finds board layouts with descriptions", () => {
    expect(LAYOUTS.length).toBeGreaterThan(20)
    const withDesc = LAYOUTS.filter((f) => descriptions(readFileSync(f, "utf8")).length > 0)
    expect(withDesc.length).toBeGreaterThan(20)
  })

  it("guards-the-guard: each pattern catches the copy it was written for, and spares definitions", () => {
    for (const s of [
      "Every TS serial #1 sale of the last 90 days. Average: 15.8×. Max: 248×.",
      "~41% delivered nothing.",
      "Over 145,000 rips audited.",
    ]) {
      expect(COMPUTED_FIGURE.some((r) => r.test(s)), `no pattern matched: ${s}`).toBe(true)
    }
    for (const s of [
      "Every Top Shot pack ripped in the last 60 days — how rare a $100+ pull really is.",
      "Every TS serial #1 sale of the last 90 days, with the multiplier vs the average serial.",
      "The 2025 rookie class, sorted by 30-day sales.",
    ]) {
      expect(COMPUTED_FIGURE.some((r) => r.test(s)), `false positive: ${s}`).toBe(false)
    }
  })

  it("BAN: no board layout description states a computed statistic", () => {
    const bad: string[] = []
    for (const file of LAYOUTS) {
      for (const d of descriptions(readFileSync(file, "utf8"))) {
        if (COMPUTED_FIGURE.some((r) => r.test(d))) bad.push(`${path.relative(ROOT, file)}\n    "${d}"`)
      }
    }
    expect(
      bad.join("\n"),
      "A statistic in static metadata is stale the day after it is written. Describe what\n" +
        "the board IS; the page and OG card carry the live numbers:\n" + bad.join("\n"),
    ).toBe("")
  })
})
