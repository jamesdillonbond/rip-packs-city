// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// MarketPulseClient renders the cross-collection secondary-market board — every
// published Flow collection (incl. UFC), each collection name linking to its
// /<slug>/overview page. The slug comes from the `sales` table via
// get_market_pulse_windows(), so it is the underscore long-form ("ufc_strike").
// This test pins the collection→URL-slug canonicalization (the drill-down link),
// not layout. Lives under app/insights/**/*Client.tsx, which the component gate
// measures.

import MarketPulseClient from "@/app/insights/market-pulse/MarketPulseClient"
import type { MarketPulseRow } from "@/lib/market-pulse-board"

const zeros = {
  sales_24h: 0, volume_24h: 0, buyers_24h: 0, top_sale_24h: null,
  sales_7d: 0, volume_7d: 0, buyers_7d: 0, sellers_7d: 0, top_sale_7d: null,
  sales_30d: 0, volume_30d: 0, buyers_30d: 0, top_sale_30d: null,
}

const rows: MarketPulseRow[] = [
  { slug: "nba_top_shot", collection_name: "NBA Top Shot", ...zeros, volume_7d: 5000 },
  { slug: "ufc_strike", collection_name: "UFC Strike", ...zeros, volume_7d: 1000 },
]

afterEach(() => cleanup())

describe("MarketPulseClient", () => {
  it("links each collection to its canonical /<slug>/overview page", () => {
    const { container } = render(
      <MarketPulseClient initialRows={rows} fetchedAt="2026-08-02T00:00:00Z" />,
    )
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/nba-top-shot/overview")
    // UFC resolves through the registry to canonical "ufc", NOT the "ufc-strike"
    // alias a naive underscore→hyphen replace on the sales-table slug emits.
    expect(hrefs).toContain("/ufc/overview")
    expect(hrefs.some((h) => h?.startsWith("/ufc-strike/"))).toBe(false)
  })
})
