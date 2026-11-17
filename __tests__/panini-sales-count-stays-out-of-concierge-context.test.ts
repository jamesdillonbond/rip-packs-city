import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-17: every Panini fmv_snapshots row carries sales_count_30d = 0 (RPC has no
// 30-day sale count for Panini). The edition page hides its "30d Sales" stat for that
// reason, but its "?" concierge context still sent ", 0 sales in 30 days" as fact.
const PAGE = path.join(path.resolve(__dirname, ".."), "app/(collections)/[collection]/edition/[slug]/page.tsx")
const SRC = stripComments(readFileSync(PAGE, "utf8"))

describe("the edition page never hands the concierge Panini's unknown sales count", () => {
  it("is not vacuous: the page still builds an ExplainButton context with the sales count", () => {
    expect(SRC).toContain("<ExplainButton")
    expect(SRC).toContain("sales in 30 days")
  })

  it("every 'sales in 30 days' context phrase is gated on !isPanini", () => {
    const sites = [...SRC.matchAll(/\$\{([^{}]*?)\?\s*`, \$\{fmv\.sales_count_30d\} sales in 30 days`/g)]
    expect(sites.length, "the context phrase moved — re-anchor this guard").toBeGreaterThan(0)
    for (const m of sites) expect(m[1], "a sales-count context phrase is not gated on !isPanini").toContain("!isPanini")
  })
})
