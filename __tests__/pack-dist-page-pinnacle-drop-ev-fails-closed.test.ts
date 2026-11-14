import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// #157 follow-up (2026-11-14, fresh-eyes review of the pack EV pages). A Disney
// Pinnacle dist is a SUB-POOL of a drop; its own gross_ev is not the pack's EV.
// The page body substituted the drop's EV, but (1) a FAILED drop-EV read fell
// through to the sub-pool EV in the Actual EV tile, right above a notice saying
// Pack EV was unavailable, and (2) the SEO description advertised the sub-pool EV
// for every Pinnacle dist. The page is an ISR server component with a dozen
// reads, so the wiring is pinned structurally (the OG card's twin is
// behaviour-tested in api-og-pack-card-data-branches).

const src = stripComments(
  readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8"),
)

describe("pack detail page — Pinnacle drop EV fails closed", () => {
  it("a failed drop-EV read withholds the page's gross EV before any substitution", () => {
    expect(src).toMatch(/const grossEv = !pinDropRes\.ok\s*\?\s*null/)
  })

  it("the no-verdict sentence says the read failed instead of 'no Gross EV … yet'", () => {
    const i = src.indexOf("grossEv == null && !pinDropRes.ok")
    const j = src.indexOf("no Gross EV for this pack yet")
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(j)
  })

  it("the SEO description reads the drop EV, and its failure withholds the figure", () => {
    expect(src).toMatch(/fetchPinnacleDropEv\(collection, distId\),\s*\]\)/)
    expect(src).toMatch(/const correctedEvReadFailed = !correctedEvRes\.ok \|\| !pinDropMetaRes\.ok/)
  })
})
