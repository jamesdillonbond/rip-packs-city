// Every `docs/overnight/inbox/INDEX.md` entry must be listed under the day heading
// that matches THE UTC DATE IN ITS OWN FILENAME.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// 2026-09-11: I filed an inbox entry late in the PT evening. UTC had already
// rolled over, so the filing was named `2026-09-12T0117Z-…` while I was thinking
// in the PT date, and its INDEX line went under the wrong heading. Nothing went
// red, and the reason is the part worth keeping:
//
//   * `inbox-index-lists-every-filing` asserts MEMBERSHIP — every file on disk is
//     listed, and no entry points at a file that is gone. Placement is not a
//     membership property, so it is structurally invisible to that guard.
//   * `scripts/fix-inbox-index-counts.mjs` recomputes each `## YYYY-MM-DD — N
//     filings` heading FROM the `- [` lines it finds under that heading. Given a
//     misplaced entry it derives a count that AGREES with the misplacement.
//
// ⛔ So the two instruments agreed with each other and were both wrong. A fixer
// that derives its expected value from the observed state cannot detect an error
// in the observed state — it LAUNDERS one into internal consistency. Pair every
// such fixer with an assertion that does not read from the thing it repairs. This
// one reads the FILENAME, which the fixer never touches.
//
// ── THE CUTOFF, AND WHY IT IS A DATE ────────────────────────────────────────
// Measured 2026-09-11 over all 431 entries: headings from 2026-08-29 onward are
// 127 entries with **ZERO** mismatches, so the UTC convention is settled there and
// this is a ban at zero, not an allowlist. The seven headings 2026-08-22 .. 08-28
// are MIXED — 63 entries there sit one day early, under a PT-dated heading — and
// those filings are permanent citation targets whose INDEX lines a later session
// should not be shuffling for cosmetics. That residue is held as a RATCHET that
// can only shrink, so repairing history greens this test and can never red it.
//
// ⚠ The mismatch is always exactly +1 day, which is what makes the diagnosis
// certain rather than a guess: it is a UTC/PT boundary, not a typo.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const INDEX = join(process.cwd(), "docs", "overnight", "inbox", "INDEX.md")

/** The first day heading with no PT/UTC contamination, measured 2026-09-11. */
const CUTOFF = "2026-08-29"

/** Entries under pre-cutoff headings that are misplaced. Measured 2026-09-11. */
const HISTORICAL_RESIDUE = 63

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})\b/
const ENTRY_LINK = /\]\((\d{4}-\d{2}-\d{2})T\d{4}Z[^)\s]*\.md\)/

export function placements(src: string) {
  const rows: { line: number; heading: string; filed: string }[] = []
  let heading: string | null = null
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const h = DAY_HEADING.exec(lines[i])
    if (h) {
      heading = h[1]
      continue
    }
    const e = ENTRY_LINK.exec(lines[i])
    if (e && heading) rows.push({ line: i + 1, heading, filed: e[1] })
  }
  return rows
}

describe("inbox INDEX entries sit under their own date", () => {
  const rows = placements(readFileSync(INDEX, "utf8"))
  const live = rows.filter((r) => r.heading >= CUTOFF)
  const historical = rows.filter((r) => r.heading < CUTOFF)

  it("inspected a non-empty population on or after the cutoff", () => {
    // A placement check that parsed nothing would pass every assertion below.
    expect(rows.length).toBeGreaterThan(300)
    expect(live.length).toBeGreaterThan(100)
  })

  it("has ZERO misplaced entries under headings on or after the cutoff", () => {
    const bad = live.filter((r) => r.filed !== r.heading)
    expect(
      bad.map((r) => `INDEX.md:${r.line} filed ${r.filed} but listed under ${r.heading}`),
    ).toEqual([])
  })

  it("holds the pre-cutoff residue as a ratchet that can only shrink", () => {
    const bad = historical.filter((r) => r.filed !== r.heading)
    expect(bad.length).toBeLessThanOrEqual(HISTORICAL_RESIDUE)
  })

  it("every misplaced historical entry is exactly one day early — a UTC/PT boundary, not a typo", () => {
    const bad = historical.filter((r) => r.filed !== r.heading)
    const offsets = new Set(
      bad.map((r) => (Date.parse(r.filed) - Date.parse(r.heading)) / 86_400_000),
    )
    expect([...offsets]).toEqual(bad.length ? [1] : [])
  })
})
