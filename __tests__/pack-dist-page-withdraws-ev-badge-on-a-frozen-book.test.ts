import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// #218 (2026-10-30). The pack detail page anchors its EV verdict on the
// secondary ask from Dapper's pack index (pack_table_rows → pack_ask_state).
// When that index froze, the page kept a "+EV" badge over a listing that may
// have sold a day earlier. The page renders through an ISR server component
// with a dozen reads, so this pins the wiring structurally; the verdict itself
// (getPackBookFreshness) is behaviour-tested in pack-deals.test.ts.

const src = stripComments(
  readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8"),
)

describe("pack detail page — frozen ask book (#218)", () => {
  it("reads the book's freshness", () => {
    expect(src).toMatch(/getPackBookFreshness\(collection\)/)
  })

  it("the +EV badge is gated off when the book is proven frozen", () => {
    const badge = /\{isPositive && grossEv !== null && showPriceVerdict[^}]*\(/.exec(src)?.[0] ?? ""
    expect(badge).toContain("!askBookFrozen")
  })

  it("a frozen book renders the out-of-date notice", () => {
    expect(src).toMatch(/\{askBookFrozen && \([\s\S]{0,600}may be out of date/)
  })
})
