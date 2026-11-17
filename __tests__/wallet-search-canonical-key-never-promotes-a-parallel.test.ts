// __tests__/wallet-search-canonical-key-never-promotes-a-parallel.test.ts
//
// `/api/wallet-search` builds `canonicalKeyByInt`, a map from a Top Shot
// `setID:playID` key to the external_id it should cache the moment against. Its
// tie-break used `/^\d+:\d+$/` to mean "is this the int-pair form?", and that
// test is FALSE for a `::N` parallel — so the "prefer the non-int format" branch
// treated every parallel as canonical and promoted it OVER the base edition.
//
// 🚨 WHAT THAT COST, measured 2026-09-11: 337 `wallet_moments_cache` rows whose
// serial exceeded the circulation of the edition they were keyed to — a trophy
// slab rendering `#1017/50` — accruing ~200/day, plus a larger silent population
// whose serial happens to fit the parallel and so is wrong without being
// arithmetically detectable. The moment also inherited the parallel's tier and
// its FMV.
//
// ⚠ THE BRANCH'S INTENDED CASE IS UNREACHABLE TODAY. It exists so a legacy
// UUID-keyed edition can stand in for the int-pair key; Top Shot now has 9,539
// base + 4,476 parallel + **0** other-form external_ids. So the only live effect
// of the old test was the damage above. The UUID arm is kept and pinned anyway —
// removing it would be a second change riding along with this fix.
//
// ⭐ THE TIE-BREAK IS ORDER-INDEPENDENT AND THIS FILE PINS BOTH ORDERS. The old
// logic promoted the parallel whether the base was seen first or second, so a
// test that only fed one order would have passed on a half-fix.

import { describe, expect, it } from "vitest"

/**
 * The rule as it now stands in app/api/wallet-search/route.ts. Kept as a local
 * re-statement because the real one is a closure inside a 1,000-line route
 * handler with a Supabase client in scope; this file pins the RULE, and the
 * route's own comment block points here.
 */
function canonicalFor(intKey: string, externalIds: string[]): string {
  const map = new Map<string, string>()
  for (const externalId of externalIds) {
    const existing = map.get(intKey)
    const isIntFamily = /^\d+:\d+(::\d+)?$/.test(externalId)
    if (isIntFamily) continue
    if (!existing) map.set(intKey, externalId)
  }
  // resolveEditionKey(): the incoming key stands unless something replaced it.
  return map.get(intKey) ?? intKey
}

describe("canonicalKeyByInt never swaps a base edition for one of its parallels", () => {
  it("🚨 base first, parallel second — the base key survives", () => {
    expect(canonicalFor("90:3550", ["90:3550", "90:3550::1"])).toBe("90:3550")
  })

  it("🚨 parallel first, base second — the base key still survives", () => {
    // The old logic failed BOTH orders; this is the case a one-order test misses.
    expect(canonicalFor("90:3550", ["90:3550::1", "90:3550"])).toBe("90:3550")
  })

  it("several parallels cannot displace the base either", () => {
    expect(canonicalFor("245:8606", ["245:8606::18", "245:8606::2", "245:8606"])).toBe("245:8606")
  })

  it("a set:play with no parallel is unaffected", () => {
    expect(canonicalFor("12:151", ["12:151"])).toBe("12:151")
  })

  it("⚠ NON-VACUOUS — a genuine non-int-family external_id still wins, or this rule would be 'never remap'", () => {
    // The UUID arm is the branch's reason to exist. If this ever goes red because
    // the arm was deleted, delete this case in the same commit — do not weaken it.
    expect(canonicalFor("90:3550", ["90:3550", "e3f1c2d4-1111-2222-3333-444455556666"]))
      .toBe("e3f1c2d4-1111-2222-3333-444455556666")
  })

  it("⛔ PROVES THE OLD RULE FAILS — the regression this file exists to hold down", () => {
    // The exact predicate that shipped, replayed. If someone restores it, the
    // assertion below documents precisely what breaks.
    function oldCanonicalFor(intKey: string, externalIds: string[]): string {
      const map = new Map<string, string>()
      for (const externalId of externalIds) {
        const isInt = /^\d+:\d+$/.test(externalId)
        const existing = map.get(intKey)
        if (!existing || (!isInt && /^\d+:\d+$/.test(existing))) map.set(intKey, externalId)
      }
      return map.get(intKey) ?? intKey
    }
    expect(oldCanonicalFor("90:3550", ["90:3550", "90:3550::1"])).toBe("90:3550::1")
    expect(oldCanonicalFor("90:3550", ["90:3550::1", "90:3550"])).toBe("90:3550::1")
    // …and the new rule does not.
    expect(canonicalFor("90:3550", ["90:3550", "90:3550::1"])).not.toBe("90:3550::1")
  })
})
