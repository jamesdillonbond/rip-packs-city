// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))

// Resolver returns a handle only for the first wallet so we can assert both the
// resolved-name path and the truncated-fallback path in one render.
vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => ({ "0x1111111111111111": "toptrader" }),
}))

import LeaderboardTable from "@/components/analytics/LeaderboardTable"

afterEach(cleanup)

describe("LeaderboardTable", () => {
  it("renders the role-specific title, badge and count-column label for sellers", () => {
    const { container } = render(
      <LeaderboardTable rows={[]} role="seller" window="L30" />
    )
    const txt = container.textContent!
    expect(txt).toContain("Top Sellers")
    expect(txt).toContain("Volume sold")
    // Empty state message uses the role noun.
    expect(txt).toContain("No seller activity in this window yet.")
  })

  it("prefers the resolved username and falls back to a truncated address otherwise", () => {
    const rows = [
      { addr: "0x1111111111111111", rank: 1, username: "0x1111…1111", sale_count: 5, total_volume_usd: 2000 },
      { addr: "0x2222222222222222", rank: 2, username: "0x2222…2222", sale_count: 3, total_volume_usd: 900 },
    ] as any
    const { container } = render(<LeaderboardTable rows={rows} role="buyer" window="L7" />)
    const txt = container.textContent!
    expect(txt).toContain("toptrader") // resolved
    expect(txt).toContain("0x2222…2222") // truncated fallback
  })

  it("reads sale_count/total_volume_usd for sales roles and formats the volume", () => {
    const rows = [
      { addr: "0x2222222222222222", rank: 1, username: "x", sale_count: 7, total_volume_usd: 1500 },
    ] as any
    const { container } = render(<LeaderboardTable rows={rows} role="buyer" window="L7" />)
    const txt = container.textContent!
    expect(txt).toContain("7") // activity count
    expect(txt).toContain("$1.5k") // formatUsd thousands rule
  })

  it("falls back to loan_count/total_principal_usd for lender rows", () => {
    const rows = [
      { addr: "0x2222222222222222", rank: 1, username: "x", loan_count: 4, total_principal_usd: 3_200_000 },
    ] as any
    const { container } = render(<LeaderboardTable rows={rows} role="lender" window="All time" />)
    const txt = container.textContent!
    expect(txt).toContain("Top Lenders")
    expect(txt).toContain("Loans")
    expect(txt).toContain("4")
    expect(txt).toContain("$3.20M")
  })

  it("shows a Repeat badge only for returning wallets", () => {
    const rows = [
      { addr: "0x2222222222222222", rank: 1, username: "x", sale_count: 1, total_volume_usd: 10, is_returning: true },
    ] as any
    const { container } = render(<LeaderboardTable rows={rows} role="buyer" window="L7" />)
    expect(container.textContent).toContain("Repeat")
  })
})
