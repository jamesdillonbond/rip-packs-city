import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── WHY THIS EXISTS (register #112) ──────────────────────────────────────────
// `wallet_moments_cache.is_locked` has `column_default false` and is nullable.
// Whole-table, measured 2026-09-13:
//
//   nba_top_shot      1,767,936 rows   34.4% ever checked   267,223 locked
//   nfl_all_day         455,244 rows   99.6% ever checked   140,084 locked
//   disney_pinnacle      56,581 rows  100.0% ever checked       370 locked
//   candy / golazos / ufc 39,357 rows   0.0% ever checked         0
//
// 1,160,468 Top Shot rows have `lock_checked_at` NULL and `is_locked = true` on
// EXACTLY ZERO of them — the perfect correlation that proves the value is the
// default rather than a reading. Among rows actually checked, 44.0% ARE locked,
// so `false` is not a benign approximation.
//
// ⛔ WHY THIS IS NOT A COSMETIC ISSUE. The analytics surface renders the tally
// as "Liquid vs Locked" under the caption "Locked moments cannot be listed or
// traded". `unlocked_fmv` is therefore a LIQUIDITY claim about the user's own
// portfolio — how much of it they could sell — and the tally was a binary
// `if (locked) … else …`, so every unchecked moment inflated it. The CSV export
// wrote the same guess as a definite `false` into a file the user keeps.
//
// ── WHAT IS PINNED ───────────────────────────────────────────────────────────
// The property is THREE STATES AT EVERY LAYER, and specifically that the
// unknown bucket is neither folded into a side nor silently dropped. A bucket
// nobody can see is the same as not splitting it out, so the disclosure in the
// client is part of the contract, not decoration.

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

const ANALYTICS = "app/api/analytics/route.ts"
const EXPORT = "app/api/portfolio-export/route.ts"
const MOMENTS = "app/api/collection-moments/route.ts"
const CLIENT = "app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx"

describe("the analytics tally has three states, not two", () => {
  const src = read(ANALYTICS)

  it("⛔ `locked` is never the FIRST branch — the unknown case must be tested before it", () => {
    // The defect's exact shape was `if (locked) {…} else {…unlockedCount…}`, so
    // the property is that a test of `locked` can only ever be an `else if`.
    //
    // ⚠ The obvious regex for this is wrong, and it failed on the CORRECT code
    // before being fixed: `/if\s*\(\s*locked\s*\)…else\s*\{…unlockedCount/`
    // matches the substring inside `else if (locked) {…} else {…}` just as
    // happily as the defect. Scan the occurrences and check what PRECEDES each
    // one instead of trying to express "not preceded by else" inside the match.
    const opens = [...src.matchAll(/if\s*\(\s*locked\s*\)/g)]
    expect(opens.length, "the locked branch disappeared entirely").toBeGreaterThan(0)
    for (const m of opens) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0)
      expect(
        before,
        `a bare \`if (locked)\` at offset ${m.index} — unknown is not tested first`,
      ).toMatch(/else\s*$/)
    }
  })

  it("the unknown bucket is counted and is checked FIRST", () => {
    // Order matters: `!lockKnown` has to be tested before `locked`, or a row with
    // a defaulted `is_locked=false` and no provenance still lands in `unlocked`.
    expect(src).toMatch(/if\s*\(\s*!lockKnown\s*\)/)
    const unknownIdx = src.indexOf("!lockKnown")
    const unlockedIdx = src.indexOf("unlockedCount++")
    expect(unknownIdx).toBeGreaterThan(-1)
    expect(unlockedIdx).toBeGreaterThan(unknownIdx)
  })

  it("provenance is read explicitly, and an ABSENT key means unknown", () => {
    // `=== true` rather than truthiness: an older deployment of
    // get_wallet_moments_with_fmv omits the key entirely, and the safe direction
    // is "everything unverified", never "resume the old overstatement".
    expect(src).toMatch(/lock_known\s*===\s*true/)
  })

  it("the unknown bucket reaches the response — an uncounted bucket is not a fix", () => {
    expect(src).toMatch(/lock_unknown_count\s*:/)
    expect(src).toMatch(/lock_unknown_fmv\s*:/)
  })
})

describe("the portfolio CSV does not export a guess as a fact", () => {
  const src = read(EXPORT)

  it("⛔ the Is Locked cell is no longer a two-way ternary on a bare boolean", () => {
    expect(src).not.toMatch(/csvCell\(\s*m\.is_locked\s*\?\s*"true"\s*:\s*"false"\s*\)/)
  })

  it("it emits a third value gated on provenance", () => {
    expect(src).toMatch(/m\.lock_known\s*===\s*true/)
    expect(src).toMatch(/"unknown"/)
  })
})

describe("collection-moments passes the tri-state through", () => {
  const src = read(MOMENTS)

  it("⛔ does not collapse unknown into false with a bare === true", () => {
    expect(src).not.toMatch(/is_locked:\s*row\.is_locked\s*===\s*true\s*,/)
  })

  it("sends null for unknown and carries the provenance flag", () => {
    expect(src).toMatch(/is_locked:\s*row\.lock_known\s*===\s*true\s*\?/)
    expect(src).toMatch(/lock_known:\s*row\.lock_known\s*===\s*true/)
  })
})

describe("the client DISCLOSES the unknown bucket", () => {
  const src = read(CLIENT)

  it("renders it — splitting a bucket out and then hiding it changes nothing", () => {
    expect(src).toMatch(/lock_unknown_count/)
    expect(src).toMatch(/lock_unknown_fmv/)
  })

  it("⛔ and does not add it back into either tile", () => {
    // The disclosure must sit BESIDE the two figures, never inside them.
    expect(src).not.toMatch(/unlocked_fmv\s*\+\s*.*lock_unknown_fmv/)
    expect(src).not.toMatch(/lock_unknown_fmv\s*\+\s*.*unlocked_fmv/)
    expect(src).not.toMatch(/unlocked_count\s*\+\s*.*lock_unknown_count/)
  })

  it("the old caption still stands, so the tiles keep saying what they mean", () => {
    expect(src).toMatch(/Locked moments cannot be listed or traded/)
  })
})

describe("the guards above actually inspected their files", () => {
  // ⚠ Every assertion in this file is a source match. If a path moves, they all
  // pass vacuously against an empty string. This is the control for that.
  it("each source is non-trivial after comment stripping", () => {
    for (const p of [ANALYTICS, EXPORT, MOMENTS, CLIENT]) {
      expect(read(p).length, `${p} read as empty`).toBeGreaterThan(2000)
    }
  })
})
