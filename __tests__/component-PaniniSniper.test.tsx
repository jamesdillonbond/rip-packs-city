// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

/**
 * PaniniSniper — the Panini Sniper tab (2026-09-28). Stated as the ABSENCE of
 * false claims: a failed read is not "no deals", a filter that hides every row
 * is not "no deals", an FMV-only deal is not presented as sale-backed, and the
 * only action offered is a link out to Panini (RPC is read-only).
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))
vi.mock("@/components/insights/DegradedDataNotice", () => ({ default: () => null }))

import PaniniSniper, { paniniEditionKeyOfSku, type PaniniSniperData, type PaniniSniperDeal } from "@/components/collection/PaniniSniper"

function deal(over: Partial<PaniniSniperDeal> = {}): PaniniSniperDeal {
  return {
    sku: "packcard-2332_486953_12679075_10__5_49", player_name: "Lionel Messi", parallel: "Base Prizms Blue", tier: "RARE",
    serial_number: 5, mint_cap: 49, ask_usd: 400, last_sale_usd: null, fmv_usd: 650, discount_pct: 38, est_profit_usd: 250,
    special_flag: null, ask_confirmed_at: "2026-09-28T15:00:00Z", recent_sales_median_usd: 600, recent_sales_n: 3,
    deal_basis: "fmv_and_recent_sales", ...over,
  }
}
function data(over: Partial<PaniniSniperData> = {}): PaniniSniperData {
  return {
    deals: [
      deal(),
      deal({ sku: "packcard-9_1_1_1__1_10", player_name: "Kylian Mbappe", parallel: "Color Blast", discount_pct: 20, est_profit_usd: 900, deal_basis: "fmv_only_no_recent_sales", recent_sales_median_usd: null, recent_sales_n: 0, special_flag: "number 1", serial_number: 1, mint_cap: 10 }),
    ],
    dealsError: false, dealsCapped: false, coverage: { total_editions: 5094, pct_trustworthy: 35.2 }, computedAt: "2026-09-28T16:00:00Z", ...over,
  }
}
afterEach(cleanup)

describe("PaniniSniper", () => {
  it("lists sale-backed deals first, links the edition page and Panini, and discloses the floor", () => {
    const c = render(<PaniniSniper data={data()} degraded={null} />).container
    const rows = [...c.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "")
    // Sale-backed Messi leads even though Mbappe's FMV-only edge is larger.
    expect(rows[0]).toContain("Lionel Messi")
    expect(rows[0]).toContain("median $600 (3)")
    expect(rows[1]).toContain("none in 30 days")
    expect(rows[1]).toContain("#1/10 · number 1")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-2332_486953_12679075_10"]')).not.toBeNull()
    expect(c.querySelector('a[href="https://nft.paniniamerica.net/marketplace-details/packcard-2332_486953_12679075_10.html"]')).not.toBeNull()
    expect(c.textContent).toContain("A floor, not a census")
    expect(c.textContent).toContain("computed Sep 28, 9:00 AM PT")
    // Read-only: no buy / cart / watch action.
    expect(c.textContent).not.toMatch(/\bBuy\b|Add to cart|Watch/)
  })

  it("a failed read says couldn't load — never 'no deals'", () => {
    for (const d of [null, data({ dealsError: true }), data({ deals: null })]) {
      const c = render(<PaniniSniper data={d} degraded={null} />).container
      expect(c.querySelector('[role="alert"]')).not.toBeNull()
      expect(c.textContent).toContain("not the same as there being no deals")
      expect(c.querySelector('[data-testid="panini-sniper-none"]')).toBeNull()
      cleanup()
    }
  })

  it("a genuinely empty board says none are 15% under — distinct from a failure", () => {
    const c = render(<PaniniSniper data={data({ deals: [] })} degraded={null} />).container
    expect(c.querySelector('[data-testid="panini-sniper-none"]')).not.toBeNull()
    expect(c.querySelector('[role="alert"]')).toBeNull()
  })

  it("filters narrow the list and say so; a filter that hides everything is not 'no deals'", () => {
    const c = render(<PaniniSniper data={data()} degraded={null} />).container
    fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "Sale-backed only")!)
    expect(c.querySelectorAll("tbody tr")).toHaveLength(1)
    expect(c.textContent).toContain("Showing 1 of 2 with your filters")
    fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "≥40% under")!)
    expect(c.querySelector('[data-testid="panini-sniper-filtered-out"]')).not.toBeNull()
    expect(c.textContent).toContain("None of the 2 deals match these filters")
    expect(c.querySelector('[data-testid="panini-sniper-none"]')).toBeNull()
  })

  it("search matches player or parallel", () => {
    const c = render(<PaniniSniper data={data()} degraded={null} />).container
    fireEvent.change(c.querySelector("#panini-sniper-q")!, { target: { value: "color blast" } })
    const rows = c.querySelectorAll("tbody tr")
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain("Kylian Mbappe")
  })

  it("a capped board says more exist", () => {
    const c = render(<PaniniSniper data={data({ dealsCapped: true })} degraded={null} />).container
    expect(c.textContent).toContain("More FMV-only deals exist")
  })

  it("paniniEditionKeyOfSku takes the edition key only from a serial sku", () => {
    expect(paniniEditionKeyOfSku("packcard-1_2_3_4__5_49")).toBe("packcard-1_2_3_4")
    expect(paniniEditionKeyOfSku("packcard-1_2_3_4")).toBeNull()
  })
})
