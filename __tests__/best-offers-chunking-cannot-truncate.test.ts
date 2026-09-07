// /api/best-offers cannot truncate, because its only caller sends fewer ids
// than one chunk — and this pins the relationship that makes that true.
//
// 🚨 WHY THIS EXISTS: IT IS A REFUTATION MADE DURABLE. An inbox filing
// (2026-09-07T0200Z) claimed the route had a truncation defect —
//
//   "One failed chunk discards all later chunks … `break` abandons EVERY
//    REMAINING CHUNK, not just this one."
//
// — because its `marketplace_offers` loop `break`s on a PostgREST error. That
// was read off the CODE SHAPE and it is WRONG. Re-derived 2026-09-07 by naming
// the caller, which the filing had not done:
//
//   · the route chunks at CHUNK = 500
//   · its ONE caller (CollectionTabClient) slices at CHUNK_SIZE = 200 BEFORE
//     it fetches, so momentIds.length <= 200
//   · 200 < 500, so the loop body runs EXACTLY ONCE, always
//
// There are no "remaining chunks" to discard. `break` and `continue` are the
// same statement here. ⭐ CLAUDE.md says it twice — "name the caller before you
// touch the function" and "a plausible mechanism is not a measurement" — and
// this is what skipping that step produces: a filed defect that does not exist.
//
// ⚠ BUT IT IS ONLY TRUE WHILE THE INEQUALITY HOLDS. Raise the client's slice
// above the route's chunk and the truncation the filing described becomes real,
// silently, in a route nobody watches. That is the trap this pins: not the
// literal numbers, but CLIENT_CHUNK <= ROUTE_CHUNK.
//
// ⛔ WHAT THIS DOES **NOT** CLEAR — stated so nobody reads a green suite as the
// whole filing being closed. The filing's SECOND problem survives and is
// untouched here: a failed `marketplace_offers` read leaves `bestOffer: null`,
// which the grid renders as a dash — identical to "nobody has bid". That is the
// read-failed / genuinely-empty collapse, it is real, and its RATE is
// unmeasured (the route is too low-traffic to appear in a short Vercel log
// window, and wider windows time out). See the filing for the disposition.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

function num(file: string, re: RegExp, label: string): number {
  const src = readFileSync(file, "utf8")
  const m = re.exec(src)
  expect(m, `${label}: pattern not found in ${file} — the constant was renamed or moved, which is itself the thing to look at`).toBeTruthy()
  const n = Number(m![1])
  expect(Number.isFinite(n) && n > 0, `${label}: parsed a non-positive size (${m![1]})`).toBe(true)
  return n
}

describe("best-offers chunking", () => {
  const ROUTE = "app/api/best-offers/route.ts"
  const CALLER = "app/(collections)/[collection]/collection/CollectionTabClient.tsx"

  it("the only caller sends no more ids than the route's chunk holds", () => {
    const routeChunk = num(ROUTE, /const CHUNK = (\d+)/, "route CHUNK")
    const callerChunk = num(CALLER, /const CHUNK_SIZE = (\d+)/, "caller CHUNK_SIZE")

    expect(
      callerChunk,
      `The Collection tab slices ${callerChunk} moment ids per request while\n` +
        `/api/best-offers chunks at ${routeChunk}. While caller <= route the route's\n` +
        `loop runs once and its \`break\` on a failed read cannot discard anything.\n` +
        `You have just inverted that, so the truncation becomes REAL: a failed\n` +
        `chunk now silently drops every later one, and nothing renders differently.\n` +
        `Fix the route (continue + carry the partialness) before raising this.`,
    ).toBeLessThanOrEqual(routeChunk)
  })

  it("the route still has exactly one such loop — the pin is about a real code path", () => {
    // Non-vacuous: if the loop is refactored away, this pin is meaningless and
    // should be re-read rather than left passing over nothing.
    const src = readFileSync(ROUTE, "utf8")
    expect(src).toMatch(/for \(let i = 0; i < momentIds\.length; i \+= CHUNK\)/)
    expect(src).toContain("marketplace_offers")
  })

  it("and the caller still slices before fetching", () => {
    // The other half of the same claim: if the client stopped chunking, the
    // route would receive an unbounded list and the inequality above would be
    // comparing a constant against nothing.
    const src = readFileSync(CALLER, "utf8")
    expect(src).toMatch(/for \(let i = 0; i < allRows\.length; i \+= CHUNK_SIZE\)/)
    expect(src).toContain('fetch("/api/best-offers"')
  })
})
