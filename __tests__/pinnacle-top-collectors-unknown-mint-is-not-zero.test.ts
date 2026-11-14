import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-14 (fresh-eyes review of the entity pages). The Pinnacle character page's
// Top Collectors coverage line did `total_minted ?? 0`. total_minted is a sum over the
// pins whose mint count is KNOWN — NULL when none is — so it printed "Covers 140 of 0
// copies (0%)", and a partial sum below the copies seen could print X of Y with X > Y.
const src = stripComments(readFileSync("app/(collections)/[collection]/player/[slug]/page.tsx", "utf8"))

describe("Pinnacle Top Collectors — an unknown mint total is not zero", () => {
  it("never coalesces total_minted to 0", () => {
    expect(src).not.toMatch(/total_minted \?\? 0/)
  })
  it("prints a share only when the denominator covers the copies seen", () => {
    expect(src).toMatch(/const share = minted != null && row\.seen_copies <= minted \?/)
    expect(src).toMatch(/share == null\s*\?/)
  })
})
