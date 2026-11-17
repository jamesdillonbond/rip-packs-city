// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

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

  // 2026-10-14: a window with no indexed sales rendered "Volume $0.00 · Sales 0 ·
  // Buyers 0" — a "nobody traded" claim the board cannot make (Candy's feed had
  // been quiet three days while a second venue sat unindexed). It now says what
  // is known: nothing indexed in the window, and when the last indexed sale was.
  describe("a window with no indexed sales is not a $0 market", () => {
    const quiet: MarketPulseRow = {
      slug: "candy_mlb", collection_name: "Candy MLB", ...zeros,
      sales_7d: 464, volume_7d: 781.83, buyers_7d: 13, sellers_7d: 30,
      last_sale_at: "2026-10-12T03:21:04Z",
    }
    const cardOf = (container: HTMLElement, name: string) =>
      Array.from(container.querySelectorAll("a")).find((a) => a.textContent === name)!.closest("div")!.parentElement!

    it("default 7d window with sales: the stats render", () => {
      const { container } = render(<MarketPulseClient initialRows={[quiet]} fetchedAt="2026-10-15T02:00:00Z" />)
      expect(cardOf(container, "Candy MLB").textContent).toContain("$782")
    })

    it("24h with zero sales: no $0, no 'Sales 0', and the last indexed sale is dated", () => {
      const { container, getByText } = render(<MarketPulseClient initialRows={[quiet]} fetchedAt="2026-10-15T02:00:00Z" />)
      fireEvent.click(getByText("24h"))
      const card = cardOf(container, "Candy MLB").textContent ?? ""
      expect(card).not.toMatch(/\$0(\.00)?\b/)
      expect(card).not.toMatch(/Sales\s*0/)
      expect(card).toContain("No sales indexed in the last 24 hours.")
      // Re-pinned 2026-10-21: PT, like every other server-rendered stamp (was ET).
      expect(card).toContain("Last indexed sale: Oct 11, 8:21 PM PT.")
    })

    it("none in 30 days says so; an older payload without the field claims no date", () => {
      const none: MarketPulseRow = { slug: "ufc_strike", collection_name: "UFC Strike", ...zeros, last_sale_at: null }
      const old: MarketPulseRow = { slug: "laliga_golazos", collection_name: "LaLiga Golazos", ...zeros }
      const { container } = render(<MarketPulseClient initialRows={[none, old]} fetchedAt="2026-10-15T02:00:00Z" />)
      expect(cardOf(container, "UFC Strike").textContent).toContain("None in the last 30 days either.")
      const oldCard = cardOf(container, "LaLiga Golazos").textContent ?? ""
      expect(oldCard).toContain("No sales indexed in the last 7 days.")
      expect(oldCard).not.toContain("Last indexed sale")
      expect(oldCard).not.toContain("None in the last 30 days")
    })
  })
})
