import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

// The live-drift check (scripts/check-db-pin-staleness.mjs) is the ONLY thing
// that can catch a pinned data-integrity function whose LIVE prod definition
// drifted (the in-CI drift guard is repo-vs-repo and structurally cannot). It
// re-derives the pin list from the drift-guard file with a regex — and on
// 2026-08-08 that regex was found to SILENTLY DROP any PINS entry carrying a
// comment between its fields (a "re-pointed 2026-…" note). Two data-critical
// pins — get_wallet_moments_with_fmv and get_team_detail — were invisible to the
// live check for exactly that reason.
//
// This test reads the script's ACTUAL regex (single source of truth — not a
// duplicate) and asserts it captures EVERY pin the guard defines, so a future
// tightening of the parser can never again silently shrink live-drift coverage.

const GUARD = resolve(process.cwd(), "__tests__/db-invariants-drift-guard.test.ts")
const SCRIPT = resolve(process.cwd(), "scripts/check-db-pin-staleness.mjs")

// The true pin count: every `fn:` field inside the PINS array. The drift-guard
// itself validates the array shape, so counting fn: keys here is authoritative.
function truePinCount(src: string): number {
  return (src.match(/^\s*fn:\s*"/gm) ?? []).length
}

// Extract the exact regex LITERAL the script uses to parse pins, so this test
// validates whatever the script actually runs — not a copy that could drift.
function scriptPinRegex(scriptSrc: string): RegExp {
  const m = scriptSrc.match(/const re = (\/.*\/g)\s*\n/)
  if (!m) throw new Error("could not locate the pin-parsing regex in check-db-pin-staleness.mjs")
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp
}

describe("db-pin staleness parser coverage", () => {
  it("the staleness script's regex captures every pin the drift guard defines", () => {
    const guardSrc = readFileSync(GUARD, "utf-8")
    const scriptSrc = readFileSync(SCRIPT, "utf-8")

    const expected = truePinCount(guardSrc)
    expect(expected).toBeGreaterThan(100) // sanity: the pin set is large

    const re = scriptPinRegex(scriptSrc)
    const captured = [...guardSrc.matchAll(re)].length

    // If this fails, a PINS entry (likely one carrying a comment between its
    // fields) is NOT being live-drift-checked. Loosen the script's regex, don't
    // lower this expectation.
    expect(captured).toBe(expected)
  })
})
