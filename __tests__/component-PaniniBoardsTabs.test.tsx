// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import type React from "react"
import { render, cleanup, fireEvent } from "@testing-library/react"
import PaniniBoardsTabs, { type PaniniBoardsPayload } from "@/app/insights/panini-squeeze/PaniniBoardsTabs"

afterEach(cleanup)

const base: PaniniBoardsPayload = {
  deals: [
    { sku: "fmv-only", player_name: "Lamine Yamal", parallel: "Zebra", tier: "LEGENDARY", serial_number: 4, mint_cap: 5, ask_usd: 12000, best_offer_usd: null, last_sale_usd: null, fmv_usd: 17500, discount_pct: 31, est_profit_usd: 5500, special_flag: null, ask_confirmed_at: "2026-09-25T13:24:00Z", recent_sales_median_usd: null, recent_sales_n: 0, deal_basis: "fmv_only_no_recent_sales" },
    { sku: "backed", player_name: "Pedri", parallel: "Silver", tier: "RARE", serial_number: 9, mint_cap: 99, ask_usd: 40, best_offer_usd: null, last_sale_usd: 60, fmv_usd: 70, discount_pct: 43, est_profit_usd: 30, special_flag: null, ask_confirmed_at: "2026-09-25T13:24:00Z", recent_sales_median_usd: 62, recent_sales_n: 3, deal_basis: "fmv_and_recent_sales" },
  ],
  deals_error: false,
  packs: [],
  packs_error: false,
  specials: [],
  specials_error: false,
  players: [],
  players_error: false,
  coverage: { total_editions: 5094, pct_trustworthy: 35.1 },
}

describe("PaniniBoardsTabs", () => {
  it("discloses the coverage gap above the boards", () => {
    const { container } = render(<PaniniBoardsTabs data={base} degraded={null} />)
    expect(container.textContent).toContain("A floor, not a census")
    expect(container.textContent).toContain("35.1%")
  })

  it("leads with SALE-backed deals; an FMV-only deal follows and says no sale backs it", () => {
    const { container } = render(<PaniniBoardsTabs data={base} degraded={null} />)
    const rows = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "")
    expect(rows[0]).toContain("Pedri")
    expect(rows[1]).toContain("Lamine Yamal")
    expect(rows[1]).toContain("none in 30 days")
  })

  it("a failed board says it failed, never 'none'", () => {
    const { container } = render(<PaniniBoardsTabs data={{ ...base, deals: null, deals_error: true }} degraded={null} />)
    expect(container.textContent).toContain("couldn't load")
    expect(container.textContent).not.toContain("No listed card is priced")
  })

  it("no payload at all renders a failure, not four empty boards", () => {
    const { container } = render(<PaniniBoardsTabs data={null} degraded={null} />)
    expect(container.textContent).toContain("couldn't load")
  })

  it("the player tab warns that its value columns can rest on asks", () => {
    const { container, getByText } = render(
      <PaniniBoardsTabs data={{ ...base, players: [{ player_name: "A", editions: 3, chases: 1, rookie_editions: 0, sealed_in_packs: 5, top_fmv_usd: 500000, catalog_fmv_usd: 502873, sealed_fmv_exposure_usd: 10, avg_rip_pct: 89 }] }} degraded={null} />,
    )
    fireEvent.click(getByText("Players"))
    expect(container.textContent).toMatch(/comes from asks/)
  })
})
