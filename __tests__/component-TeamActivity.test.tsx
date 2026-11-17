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

  // A window wider than the 15-row Recent list: the largest-of column ranks rows not yet shown.
  const wide = (extra: ReturnType<typeof row>[]) => [
    ...Array.from({ length: 15 }, (_, i) => row({ route_slug: `r${i}`, player_name: `Filler ${i}`, price_usd: 1 })),
    ...extra,
  ]

  it("names the window it ranks: 'Largest of the last N sales', price-sorted, $0 excluded", () => {
    const rows = wide([
      row({ route_slug: "grail", player_name: "Grail One", price_usd: 5000 }),
      row({ route_slug: "zero", player_name: "Zero One", price_usd: 0 }),
    ])
    const { getByText, queryByText, container } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={rows} />)
    expect(getByText("Recent sales")).toBeTruthy()
    expect(getByText("Largest of the last 17 sales")).toBeTruthy()
    expect(container.textContent).not.toContain("Biggest recent sales")
    expect(queryByText("Grail One")).toBeTruthy() // only reachable through the largest-of column
    expect(queryByText("Zero One")).toBeNull()
  })

  // 2026-10-25: the franchise hub passes 6 rows; a "biggest" column over them re-sorted the
  // same sales and read $0.15 beside $938 of 30-day volume. Every row is already listed.
  it("⛔ no largest-of column when the Recent list already shows every fetched sale", () => {
    const rows = [row({ route_slug: "a", price_usd: 0.15 }), row({ route_slug: "b", price_usd: 0.1 })]
    const { container } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={rows} />)
    expect(container.textContent).toContain("Recent sales")
    expect(container.textContent).not.toMatch(/Largest of|Biggest recent sales/)
  })

  it("hides the largest-of column when every price is non-positive", () => {
    const rows: ActivityRow[] = [...wide([]).map(r => ({ ...r, price_usd: 0 })), row({ price_usd: null })]
    const { queryByText } = render(<TeamActivity collectionUrlSlug="nba-top-shot" rows={rows} />)
    expect(queryByText(/Largest of/)).toBeNull()
    expect(queryByText("Recent sales")).toBeTruthy()
  })

  it("⛔ a Pinnacle sale row is titled by the pin, never its first character (#23)", () => {
    const { container } = render(
      <TeamActivity collectionUrlSlug="disney-pinnacle" rows={[row({ route_slug: "LEV1-SLBT-SPIN-S6", pin_name: "Spindle of Fate", player_name: "Aurora" })]} />,
    )
    expect(container.textContent).toContain("Spindle of Fate")
    expect(container.textContent).not.toContain("Aurora")
  })
})
