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
  // 2026-11-27: the panel and its coverage line were retired with the other walked-wallet rankings (the Top
  // Collector Leaderboard ranks only from a full census). The "X of 0 copies" line cannot render because its only
  // source is no longer read — pinned as that absence, not deleted.
  it("no longer reads the partial Pinnacle owner-map ranking the coverage line came from", () => {
    expect(src).not.toContain("get_pinnacle_character_top_collectors")
    expect(src).not.toMatch(/Covers \{fmtCount\(row\.seen_copies\)\}/)
  })
})
