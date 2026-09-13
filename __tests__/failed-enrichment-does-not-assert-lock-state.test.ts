import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { getLocked, isLockKnown } from "../lib/collection/helpers"

// A failed per-moment enrichment must not render as a NEGATIVE FINDING.
//
//     } catch {
//       return { isLocked: false, officialBadges: [], ... }   // ⛔
//     }
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// `/api/wallet-search` enriches each moment from Top Shot's GraphQL. When that
// call throws, the catch block builds a replacement row. It was honest about
// exactly one field — `playerName: "Unknown (error loading)"` — and asserted
// every other one: `isLocked: false`, `officialBadges: []`,
// `specialSerialTraits: []`. The author was plainly thinking about failure and
// simply did not carry it to the boolean and the arrays, where `false` and `[]`
// are indistinguishable from a measured reading.
//
// This is the repo's documented fabricated-value shape (`?? 0`, `|| 1`) in
// boolean form, and it reached the user: `getLocked` is
// `Boolean(row.isLocked ?? row.locked)`, and `CollectionMomentTable` renders
// LOCKED as `isLocked ? "Yes" : "No"` with the "—" branch hardcoded to All Day.
// So a Top Shot moment whose read failed published a definite **"No"** — a
// false claim about whether the user can sell their own asset.
//
// ⚠ NOT hypothetical. Measured in production 2026-09-13: Top Shot GraphQL was
// answering **530** for 100% of moments (200 occurrences in 24h, every sampled
// request failing all of its moments), so every Top Shot row served by wallet
// search was taking this path.
//
// ── WHY THE SHAPE AND NOT THE BEHAVIOUR ────────────────────────────────────
// The sibling guard `catch-blocks-do-not-assert-completeness` covers paged-list
// termination flags (`setExhausted(true)`) and could never have seen this: the
// claim here is a VALUE in a returned object, not a flag. Same family, adjacent
// sub-class. The source shape is what discriminates, so pin that.

const ROUTE = join(process.cwd(), "app/api/wallet-search/route.ts")

/** The catch block that builds the replacement row, comments stripped. */
function fallbackBlock(): string {
  const src = stripComments(readFileSync(ROUTE, "utf8"))
  const start = src.indexOf("catch (momentErr")
  expect(start, "the per-moment catch block must still exist").toBeGreaterThan(-1)
  // Bounded slice: the replacement object literal is returned inside this block.
  return src.slice(start, start + 2000)
}

describe("a failed moment enrichment does not assert lock state or badges", () => {
  it("the wallet-search fallback row does not claim isLocked: false", () => {
    expect(fallbackBlock()).not.toMatch(/isLocked\s*:\s*false/)
  })

  it("the wallet-search fallback row does not claim empty badges or traits", () => {
    const block = fallbackBlock()
    expect(block).not.toMatch(/officialBadges\s*:\s*\[\s*\]/)
    expect(block).not.toMatch(/specialSerialTraits\s*:\s*\[\s*\]/)
  })

  it("the wallet-search fallback marks the row as failed enrichment", () => {
    expect(fallbackBlock()).toMatch(/enrichFailed\s*:\s*true/)
  })
})

describe("isLockKnown separates unknown from measured-unlocked", () => {
  it("an enrichment failure is UNKNOWN, not unlocked", () => {
    const row = { enrichFailed: true } as any
    expect(isLockKnown(row)).toBe(false)
    // getLocked still returns false — that is its documented two-state contract,
    // and it is exactly why a caller that ASSERTS to the user must gate on
    // isLockKnown instead. Pinned so the two cannot silently converge.
    expect(getLocked(row)).toBe(false)
  })

  it("a row with no lock field at all is UNKNOWN", () => {
    expect(isLockKnown({} as any)).toBe(false)
  })

  it("a measured false is KNOWN and unlocked", () => {
    const row = { isLocked: false } as any
    expect(isLockKnown(row)).toBe(true)
    expect(getLocked(row)).toBe(false)
  })

  it("a measured true is KNOWN and locked", () => {
    const row = { isLocked: true } as any
    expect(isLockKnown(row)).toBe(true)
    expect(getLocked(row)).toBe(true)
  })
})

describe("the table gates its LOCKED assertion on isLockKnown", () => {
  it("the LOCKED expand field renders an em dash when lock state is unknown", () => {
    const src = stripComments(
      readFileSync(join(process.cwd(), "components/collection/CollectionMomentTable.tsx"), "utf8")
    )
    // The assertion branch must be guarded. Asserting the ABSENCE of an
    // ungated `isLocked ? "Yes" : "No"` is what this pins — a test for the
    // PRESENCE of isLockKnown anywhere in the file would pass on an import alone.
    const ungated = /\{\s*lockUntracked\s*\?\s*"—"\s*:\s*\(\s*isLocked\s*\?\s*"Yes"\s*:\s*"No"\s*\)\s*\}/
    expect(src).not.toMatch(ungated)
    expect(src).toMatch(/!isLockKnown\(row\)\s*\?\s*"—"/)
  })
})
