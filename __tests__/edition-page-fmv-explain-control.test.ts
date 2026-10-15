import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-10-14: the most-asked FMV questions in real concierge traffic were "what
// does the confidence word mean", "does FMV account for special serials" and
// "how do you price thin editions" (support_conversations 10134, 10141, 10422),
// asked from the edition page with no way to ask ABOUT that page's number. The
// "Current FMV" tile now carries the "?" control that opens the concierge with
// the question and the page's own figures as context.
//
// Pinned as source text (the page is an async server component, rendered
// nowhere in the unit suite): the control sits inside the Current FMV tile, it
// is gated on a real FMV (a "?" beside an em-dash would ask the concierge to
// explain a number that does not exist), and its context carries the edition's
// own FMV, confidence and sales count rather than a generic question.

const PAGE = readFileSync(
  join(__dirname, "..", "app", "(collections)", "[collection]", "edition", "[slug]", "page.tsx"),
  "utf8",
)

describe("edition page: the Current FMV tile can be asked about", () => {
  const start = PAGE.indexOf('label="Current FMV"')
  const end = PAGE.indexOf("<StatCell", start + 1)
  const tile = PAGE.slice(start, end)

  it("renders ExplainButton inside the Current FMV tile", () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(tile).toContain("<ExplainButton")
    expect(PAGE).toContain('import ExplainButton from "@/components/ExplainButton"')
  })

  it("only when there is a real FMV to explain", () => {
    expect(tile).toMatch(/\{fmvAvailable && \(\s*<ExplainButton/)
  })

  it("passes this edition's own figures as context", () => {
    const ctx = tile.slice(tile.indexOf("<ExplainButton"))
    for (const field of ["fmv?.fmv_usd", "fmv?.confidence", "fmv?.sales_count_30d", "editionTitle"]) {
      expect(ctx, `context should carry ${field}`).toContain(field)
    }
  })
})
