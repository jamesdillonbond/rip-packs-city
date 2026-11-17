import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-18 (Trevor: "We shouldn't have anything user-facing that shows our
// confidence in the pricing. That should just be for internal use."). The
// public /api/fmv response STILL carries `confidence` (its shape is a contract
// and is unchanged), but the public API docs page no longer documents it —
// not in the field list, not in the examples, not in the methodology blurb.
const SRC = stripComments(
  readFileSync(join(process.cwd(), "app", "(analytics)", "analytics", "api", "page.tsx"), "utf8"),
)

describe("/analytics/api docs page", () => {
  it("does not document the confidence field or its tiers", () => {
    expect(SRC).not.toMatch(/confidence/i)
    expect(SRC).not.toMatch(/ask_only|sales_only|no_data/)
  })

  it("still documents the rest of the per-result fields (the scan read the real page)", () => {
    for (const f of ["fmv", "adjustedFmv", "updatedAt", "fallbackTier", "salesCount30d", "daysSinceSale"]) {
      expect(SRC).toContain(`<code>${f}</code>`)
    }
  })
})
