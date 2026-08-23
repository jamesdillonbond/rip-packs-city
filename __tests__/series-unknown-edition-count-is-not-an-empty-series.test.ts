import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// `/[collection]/series/[slug]` decides whether to render
// "No editions in this series yet" — and, in the same expression, whether to
// fetch the editions grid and the set/player rollups at all.
//
// Until 2026-08-23 that decision read `(detail.edition_count ?? 0) === 0`,
// which was harmless only because `get_series_detail` always COMPUTED the
// count. It now reads it from `series_detail_rollup`, where a missing row means
// UNKNOWN — a series that exists but has not been rolled up yet. Under `?? 0`
// that unknown renders as a confident "this series has no editions", AND
// short-circuits the two fetches that would otherwise have contradicted it.
// Three states, not two: rolled up and empty · rolled up and non-empty · not
// rolled up. Only the first may render the empty state.
//
// ⚠ This is a NARROW ban, deliberately. `(x ?? 0) === 0` appears at 12 sites in
// this repo and most are legitimate — `parallel_id ?? 0` is a data convention,
// not a count read. Banning the shape everywhere would be a rule with no
// failure behind it. What is banned here is the shape ON THE DECISION THAT
// RENDERS AN EMPTINESS CLAIM, on the one page where the source of that count
// changed.

const PAGE = join(process.cwd(), "app", "(collections)", "[collection]", "series", "[slug]", "page.tsx")
const src = readFileSync(PAGE, "utf8")

/**
 * True when `s` decides emptiness by coalescing an unknown count to zero.
 * Extracted so the assertion below can be given a POSITIVE CONTROL — a guard
 * whose detector is never shown a real offender is a guard whose passing means
 * nothing.
 */
function coalescesUnknownCountToEmpty(s: string): boolean {
  return /isEmpty\s*=\s*\(?[^\n]*\?\?\s*0\s*\)?\s*[=<]/.test(s)
}

describe("an unrolled-up series is not an empty series", () => {
  it("the detector fires on the exact pre-fix expression (positive control)", () => {
    expect(
      coalescesUnknownCountToEmpty("  const isEmpty = (detail.edition_count ?? 0) === 0"),
      "the detector must see the shape it exists to ban",
    ).toBe(true)
    // ...and not on the fixed one, so the assertion below is discriminating
    // rather than merely satisfiable.
    expect(coalescesUnknownCountToEmpty("  const isEmpty = detail.edition_count === 0")).toBe(false)
  })

  it("found the page, and it still makes an emptiness decision at all", () => {
    // Two-level positive control: a moved file or a renamed decision would make
    // every assertion below vacuous, and they fail differently.
    expect(src.length).toBeGreaterThan(2000)
    expect(src, "the page must still branch on emptiness").toMatch(/const isEmpty\s*=/)
  })

  it("decides emptiness on a MEASURED zero, never on a coalesced unknown", () => {
    expect(coalescesUnknownCountToEmpty(src)).toBe(false)
  })

  it("a genuine zero still renders the empty state", () => {
    // No-change control. ufc_strike series 0 really has 0 editions (measured
    // 2026-08-23: 1 of 26 series), so removing the branch entirely would be the
    // mirror-image defect — an empty series rendering an editions grid that
    // will always be blank, with no explanation.
    expect(src).toContain("No editions in this series yet")
    expect(src).toMatch(/isEmpty\s*\?/)
  })
})
