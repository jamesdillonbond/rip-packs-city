// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"

// 2026-09-29: panini_coverage_summary measures 2026 Prizm World Cup ONLY (panini_wc_editions), while
// the Panini Market tab now also lists other products' editions (the products bridge). A bare
// "RPC indexes N editions" beside that list reads as the size of everything shown. The count must
// name its scope, and the note must say other products are covered more thinly.
afterEach(cleanup)

describe("PaniniCoverageNote — the count names the catalogue it measures", () => {
  it("says the indexed count is World Cup's, and that other products are thinner and excluded", () => {
    const { container } = render(
      <PaniniCoverageNote
        coverage={{ total_editions: 5124, pct_trustworthy: 35, listing_gated_editions: null, listing_gated_families: null, families: 62, edition_age_p50_h: 20, edition_age_p90_h: 40, pct_editions_stale_45d: 0 } as never}
        failed={false}
      />,
    )
    const t = (container.textContent ?? "").replace(/\s+/g, " ")
    expect(t).toMatch(/RPC indexes 5,124 2026 Prizm World Cup editions/)
    expect(t).not.toMatch(/RPC indexes 5,124 editions/)
    expect(t).toMatch(/Other Panini products .* not included in these figures/)
  })
})
