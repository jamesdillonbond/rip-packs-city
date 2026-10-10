// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

/**
 * /insights/panini-premiums client (2026-10-10). Absences: a failed read is not "no premiums", a
 * filter that hides every row is not "no premiums", an unnamed product is not given a made-up
 * name, and the only action is a link to RPC's edition page.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniPremiumsClient from "@/app/insights/panini-premiums/PaniniPremiumsClient"
import type { PaniniPremiumsPayload } from "@/lib/insights/panini-premiums"

function payload(over: Partial<PaniniPremiumsPayload> = {}): PaniniPremiumsPayload {
  return {
    parallels: [
      { product_set_id: 2332, product_name: "2026 Panini NFT Prizm World Cup Soccer", sport: "Soccer", player_name: "Lionel Messi", external_id: "packcard-2332_1_1_10", parallel: "Base Prizms Gold", mint_cap: 10, thumbnail_url: null, parallel_fmv_usd: 650, parallel_confidence: "HIGH", base_external_id: "packcard-2332_1_2_10", base_parallel: "Base Prizms Silver", base_mint_cap: 259, base_fmv_usd: 10, base_confidence: "MEDIUM", premium_mult: 65 },
      { product_set_id: 1972, product_name: null, sport: "Basketball", player_name: "Victor Wembanyama", external_id: "packcard-1972_1_1_10", parallel: "Gold", mint_cap: 10, thumbnail_url: null, parallel_fmv_usd: 100, parallel_confidence: "HIGH", base_external_id: "x", base_parallel: "Base", base_mint_cap: 999, base_fmv_usd: 5, base_confidence: "HIGH", premium_mult: 20 },
    ],
    parallelsCapped: false,
    serials: [
      { product_set_id: 1940, product_name: "2023 Panini NFT Prizm Football", sport: "Football", player_name: "Patrick Mahomes", parallel: "Base", thumbnail_url: null, external_id: "packcard-1940_1_1_1", sku: "packcard-1940_1_1_1__1_999", serial_number: 1, mint_cap: 999, headline: "number 1", sale_usd: 500, sold_at: "2026-10-01T18:00:00Z", edition_median_usd: 5, edition_sales_n: 12, premium_mult: 100 },
    ],
    serialsCapped: false,
    ...over,
  }
}
afterEach(cleanup)

describe("PaniniPremiumsClient", () => {
  it("lists parallels with product, base and premium, links RPC's edition page, and names an unnamed product by id", () => {
    const c = render(<PaniniPremiumsClient data={payload()} fetchedAt="2026-10-10T22:00:00Z" failed={false} />).container
    const rows = [...c.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "")
    expect(rows[0]).toContain("Lionel Messi")
    expect(rows[0]).toContain("Base Prizms Silver/259")
    expect(rows[0]).toContain("65×")
    expect(rows[1]).toContain("Panini product 1972 · Basketball")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-2332_1_1_10"]')).not.toBeNull()
    expect(c.textContent).toContain("Read Oct 10, 3:00 PM PT")
    expect(c.textContent).not.toMatch(/\bBuy\b|Add to cart/)
  })

  it("the serials tab shows the real sale against the edition's typical sale and says it is a floor", () => {
    const c = render(<PaniniPremiumsClient data={payload()} fetchedAt={null} failed={false} />).container
    fireEvent.click([...c.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes("serials"))!)
    const row = c.querySelector("tbody tr")!.textContent ?? ""
    expect(row).toContain("#1/999 · number 1")
    expect(row).toContain("$500")
    expect(row).toContain("(12 sales)")
    expect(row).toContain("100×")
    expect(c.textContent).toContain("a floor, not a census")
  })

  it("a failed read says couldn't load — never 'no premiums'", () => {
    const c = render(<PaniniPremiumsClient data={payload({ parallels: [], serials: [] })} fetchedAt={null} failed />).container
    expect(c.querySelector('[role="alert"]')).not.toBeNull()
    expect(c.textContent).toContain("not the same as there being no premiums")
    expect(c.querySelector('[data-testid="panini-premiums-none"]')).toBeNull()
  })

  it("a genuinely empty board says so, distinct from a failure", () => {
    const c = render(<PaniniPremiumsClient data={payload({ parallels: [] })} fetchedAt={null} failed={false} />).container
    expect(c.querySelector('[data-testid="panini-premiums-none"]')).not.toBeNull()
    expect(c.querySelector('[role="alert"]')).toBeNull()
  })

  it("the sport filter narrows; a search that hides everything says the filter did it", () => {
    const c = render(<PaniniPremiumsClient data={payload()} fetchedAt={null} failed={false} />).container
    fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "Basketball")!)
    expect(c.querySelectorAll("tbody tr")).toHaveLength(1)
    expect(c.textContent).toContain("Showing 1 of 2")
    fireEvent.change(c.querySelector("#panini-premiums-q")!, { target: { value: "zzz" } })
    expect(c.querySelector('[data-testid="panini-premiums-filtered-out"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="panini-premiums-none"]')).toBeNull()
  })
})
