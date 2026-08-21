// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import TeamActivity, { type ActivityRow } from "@/components/entity/TeamActivity"

// Drives the Team Hub activity view (prop-driven server component): the empty
// state, the "Recent sales" list, and the "Biggest recent sales" column derived
// by sorting the SAME rows by price desc and dropping non-positive prices.

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

afterEach(() => cleanup())

const row = (over: Partial<ActivityRow>): ActivityRow => ({
  route_slug: "r",
  player_name: "Player",
  set_name: "Base",
  tier: "COMMON",
  thumbnail_url: null,
  serial_number: null,
  price_usd: 100,
  sold_at: "2026-04-15T00:00:00Z",
  marketplace: null,
  ...over,
})

describe("TeamActivity", () => {
  it("renders the empty state with no rows", () => {
    const { getByText } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={[]} />)
    expect(getByText("No recent sales.")).toBeTruthy()
  })

  it("a DEGRADED activity read says so — never 'No recent sales.'", () => {
    // The team page fires SIX section RPCs in one Promise.all; the pool-acquire
    // timeouts that fan-out produces are exactly what degrades this section to
    // [], and until now that rendered as a factual claim that the franchise had
    // no recent sales.
    const { container } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={[]} ok={false} />)
    expect(container.textContent).not.toMatch(/No recent sales/i)
    expect(container.textContent).toContain("couldn't be loaded")
  })

  it("a genuinely quiet team keeps 'No recent sales.'", () => {
    const { container } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={[]} ok={true} />)
    expect(container.textContent).toContain("No recent sales.")
    expect(container.textContent).not.toContain("couldn't be loaded")
  })

  it("renders Recent sales and a price-sorted Biggest recent sales column", () => {
    const rows = [
      row({ route_slug: "cheap", player_name: "Cheap One", price_usd: 10 }),
      row({ route_slug: "grail", player_name: "Grail One", price_usd: 5000 }),
      row({ route_slug: "zero", player_name: "Zero One", price_usd: 0 }), // excluded from biggest
    ]
    const { getByText, getAllByText } = render(
      <TeamActivity collectionUrlSlug="nba-top-shot" rows={rows} />,
    )
    expect(getByText("Recent sales")).toBeTruthy()
    expect(getByText("Biggest recent sales")).toBeTruthy()
    // the grail ($5,000) appears in both columns; the $0 row never in "biggest"
    expect(getAllByText("Grail One").length).toBe(2)
    expect(getAllByText("Zero One").length).toBe(1) // recent only
  })

  it("hides the Biggest column when every price is non-positive", () => {
    const rows = [row({ price_usd: 0 }), row({ price_usd: null })]
    const { queryByText } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={rows} />)
    expect(queryByText("Biggest recent sales")).toBeNull()
    expect(queryByText("Recent sales")).toBeTruthy()
  })
})
