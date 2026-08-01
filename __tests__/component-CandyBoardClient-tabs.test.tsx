// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"
import React from "react"

// Supplementary CandyBoardClient coverage. The existing
// component-CandyBoardClient.test.tsx drives Market / pack panel / Deals /
// Serials; this file covers the FOUR remaining tab branches (Spread, Scarcity,
// Holders, Players) and the Market tab's CLIENT-SIDE controls (column-sort
// toggle, tier filter, player search) — all previously dark on the ~600-line,
// 61%-covered board. Everything here is client-side over the server-rendered
// props, so no network stub is needed.

import CandyBoardClient from "@/app/insights/candy-mlb/CandyBoardClient"

const marketRows = [
  {
    external_id: "bobby-witt-jr", player_name: "Bobby Witt Jr.", edition_name: "Bobby Witt Jr.",
    tier: "COMMON", is_rainbow: false, circulation_count: 250, fmv_usd: 8.31,
    fmv_computed_at: "2026-07-27T10:00:00Z", sales_24h: 1, sales_7d: 4, sales_all: 4,
    last_sale_at: "2026-07-27T09:00:00Z", last_sale_usd: 20.04, last_sale_serial: 118,
    median_sale_usd: 4.44, best_offer_usd: 1.5, offer_bidders: 2, floor_ask_usd: 4.58,
    listing_count: 3, excluded_troll_count: 0,
  },
  {
    external_id: "julio-rainbow", player_name: "Julio Rodriguez", edition_name: "Julio Rodriguez",
    tier: "LEGENDARY", is_rainbow: true, circulation_count: 25, fmv_usd: 180.5,
    fmv_computed_at: "2026-07-27T10:00:00Z", sales_24h: 0, sales_7d: 1, sales_all: 1,
    last_sale_at: "2026-07-26T09:00:00Z", last_sale_usd: 180.5, last_sale_serial: 3,
    median_sale_usd: 180.5, best_offer_usd: 40, offer_bidders: 1, floor_ask_usd: 200,
    listing_count: 1, excluded_troll_count: 0,
  },
]

const spreads = [
  {
    external_id: "e-spread", player_name: "Spread Player", edition_name: "Spread Player", tier: "COMMON",
    best_offer_usd: 3, distinct_bidders: 2, floor_usd: 5, spread_usd: 2, spread_pct: 40, fmv_usd: 6,
  },
]
const scarcity = [
  {
    external_id: "e-scar", player_name: "Scarce Player", edition_name: "Scarce Player", tier: "COMMON",
    circulation_count: 250, sealed: 200, circulating: 50, circulating_pct: 20, holders: 30, fmv_usd: 12,
  },
]
const holders = [
  { wallet_address: "0xholderwallet", serials: 42, editions: 20, priced_serials: 18, est_fmv_usd: 900 },
]
const players = [{ player_name: "Rollup Player", editions: 4, priced: 3, avg_fmv: 25 }]
const parallel = [
  { is_rainbow: false, avg_fmv: 6, priced: 98, editions: 100 },
  { is_rainbow: true, avg_fmv: 170, priced: 11, editions: 25 },
]

const packEv = {
  icon_slots: 10, rainbow_chance: 0.15, pack_cost_usd: 10, common_total: 100, common_priced: 98,
  rainbow_total: 25, rainbow_priced: 11, actual_ev_usd: 63.81, typical_pull_ev_usd: 34.2,
}

type BoardProps = React.ComponentProps<typeof CandyBoardClient>

function mount(overrides: Record<string, unknown> = {}) {
  const props = {
    initialRows: marketRows, packEv, packMarket: null,
    deals: [], spreads, serials: [], scarcity, holders, players, parallel,
    fetchedAt: "2026-07-27T10:30:00Z", ...overrides,
  } as unknown as BoardProps
  return render(<CandyBoardClient {...props} />)
}

function tabButton(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  )
  if (!el) throw new Error(`tab "${label}" not found`)
  return el as HTMLElement
}

afterEach(cleanup)

describe("CandyBoardClient — remaining tab branches", () => {
  it("renders the Spread tab (bid↔ask table)", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Spread"))
    expect(container.textContent).toMatch(/standing offer/i)
    expect(container.textContent).toMatch(/Spread Player/)
  })

  it("renders the Scarcity tab (sealed vs circulating)", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Scarcity"))
    expect(container.textContent).toMatch(/sealed vs circulating/i)
    expect(container.textContent).toMatch(/Scarce Player/)
  })

  it("renders the Holders tab (concentration table)", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Holders"))
    expect(container.textContent).toMatch(/Holder concentration/i)
  })

  it("renders the Players tab with the Core vs Rainbow rollup + premium multiple", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Players"))
    expect(container.textContent).toMatch(/Core ICON/i)
    expect(container.textContent).toMatch(/Rainbow parallel/i)
    // rbMultiple = rainbow.avg_fmv / core.avg_fmv = 170/6 ≈ 28.3× premium
    expect(container.textContent).toMatch(/premium/i)
  })

  it("shows each tab's empty state when its data set is empty", () => {
    const { container } = mount({ spreads: [], scarcity: [], holders: [] })
    fireEvent.click(tabButton(container, "Spread"))
    expect(container.textContent).toMatch(/No offers or asks yet/i)
    fireEvent.click(tabButton(container, "Holders"))
    expect(container.textContent).toMatch(/No holders/i)
  })
})

describe("CandyBoardClient — Market tab client-side controls", () => {
  it("toggles the sort direction when a column header is clicked", () => {
    const { container } = mount()
    const headers = container.querySelectorAll("th")
    // Click the first sortable header twice → set-then-flip asc (setSortK/setAsc)
    const th = headers[0] as HTMLElement
    fireEvent.click(th)
    fireEvent.click(th)
    // Both editions still present after re-sorts
    expect(container.textContent).toMatch(/Bobby Witt Jr\./)
    expect(container.textContent).toMatch(/Julio Rodriguez/)
  })

  it("filters to Rainbows only via the tier control", () => {
    const { container } = mount()
    fireEvent.click(tabButton(container, "Rainbows"))
    expect(container.textContent).toMatch(/Julio Rodriguez/)
    expect(container.textContent).not.toMatch(/Bobby Witt Jr\./)
  })

  it("narrows the table with the player search input", () => {
    const { container } = mount()
    const input = container.querySelector('input[placeholder^="Filter player"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: "julio" } })
    expect(container.textContent).toMatch(/Julio Rodriguez/)
    expect(container.textContent).not.toMatch(/Bobby Witt Jr\./)
  })
})
