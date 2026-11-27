import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-27: a reward pack (retail $0) WITH a live secondary ask gets the same ask-anchored verdict on its
// page as on the packs board, its share card and the concierge. The old gate ("verdicts divide by retail")
// predated the 2026-07-07 reframe that anchors every verdict on the ask (deriveEvVerdict(grossEv, ask)).
// Fit Check (Diced), dist 2869: the board said −79.9 %, the page said "no price-based verdict".
// Asserted on source: the page is a server component with ~20 reads, not renderable in a unit test.
const src = stripComments(readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8"))

describe("pack page: a reward pack's verdict is anchored on its ask, like every other surface", () => {
  it("does not gate the price verdict on retail", () => {
    const m = src.match(/const showPriceVerdict = ([^\n]+)/)
    expect(m, "showPriceVerdict declaration").not.toBeNull()
    expect(m![1]).not.toMatch(/isRewardPack/)
    expect(m![1]).toMatch(/secondaryAskAnchor != null/)
  })

  it("says 'no verdict' only for a reward pack with NO live ask", () => {
    expect(src).toMatch(/const rewardNoAsk = isRewardPack && secondaryAskAnchor == null/)
    expect(src).not.toMatch(/isRewardPack \? "No standalone retail/)
    expect(src).not.toMatch(/isRewardPack \? "No retail price/)
    expect(src).not.toMatch(/if \(isRewardPack\) return "No standalone retail/)
  })

  it("the verdict itself is the ask-anchored one", () => {
    expect(src).toMatch(/deriveEvVerdict\(grossEv, secondaryAskAnchor\)/)
  })
})
