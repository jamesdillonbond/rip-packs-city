// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import MarketplaceMix from "@/components/analytics/MarketplaceMix"

afterEach(cleanup)

describe("MarketplaceMix", () => {
  it("shows an empty state when data is null or has no keys", () => {
    const nullCase = render(<MarketplaceMix data={null} />)
    expect(nullCase.container.textContent).toContain("No marketplace activity")
    cleanup()
    const emptyCase = render(<MarketplaceMix data={{}} />)
    expect(emptyCase.container.textContent).toContain("No marketplace activity")
  })

  it("shows a no-volume empty state when all usd totals are zero", () => {
    const { container } = render(
      <MarketplaceMix data={{ topshot: { count: 5, usd: 0 } }} />
    )
    expect(container.textContent).toContain("No marketplace volume")
  })

  it("renders known slices with labels, formatted totals and percentages", () => {
    const { container } = render(
      <MarketplaceMix
        data={{
          topshot: { count: 1500, usd: 3_000_000 },
          flowty: { count: 100, usd: 1_000_000 },
        }}
      />
    )
    const txt = container.textContent!
    expect(txt).toContain("Top Shot marketplace")
    expect(txt).toContain("Flowty (NFTStorefrontV2)")
    // fmtUsd: 3M -> $3.00M total is 4M; 3M slice + 1M slice
    expect(txt).toContain("$4.00M total")
    expect(txt).toContain("$3.00M")
    // 3M / 4M = 75%
    expect(txt).toContain("75.0%")
    // fmtCount: 1500 -> 1.5k
    expect(txt).toContain("1.5k sales")
  })

  it("merges the 'pinnacle' alias into the 'on-chain' bucket", () => {
    const { container } = render(
      <MarketplaceMix
        data={{
          "on-chain": { count: 2, usd: 100 },
          pinnacle: { count: 3, usd: 150 },
        }}
      />
    )
    // Only one "Pinnacle direct" slice should appear, summing usd 250 / count 5.
    const labels = container.textContent!.match(/Pinnacle direct/g) ?? []
    expect(labels.length).toBe(1)
    expect(container.textContent).toContain("5 sales")
  })

  it("buckets unknown marketplace keys into an 'Other' slice", () => {
    const { container } = render(
      <MarketplaceMix
        data={{
          topshot: { count: 10, usd: 500 },
          weirdmarket: { count: 4, usd: 500 },
        }}
      />
    )
    expect(container.textContent).toContain("Other")
    // 500/1000 = 50%
    expect(container.textContent).toContain("50.0%")
  })
})
