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
    best_offer_usd: 3, distinct_bidders: 2, floor_usd: 5, fmv_usd: 6,
    same_copy: true, floor_copy_bid_usd: 3, exec_spread_usd: 2, exec_spread_pct: 40,
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

  it("renders every holder row when the set exceeds the old 250 cap (badge must match table)", () => {
    // The Holders tab badge shows holders.length (the full fetched count), but
    // DataTable slices to `cap`. With the old cap=250 a set of 407 (live count)
    // rendered only 250 rows while the badge said 407 — a silent drop. Pin that
    // a >250 holder set renders in full.
    const many = Array.from({ length: 300 }, (_, i) => ({
      wallet_address: `0xholder${String(i).padStart(4, "0")}`,
      serials: 300 - i,
      editions: 10,
      priced_serials: 5,
      est_fmv_usd: 100,
    }))
    const { container } = mount({ holders: many })
    fireEvent.click(tabButton(container, "Holders"))
    // Count rendered holder rows: the Holders table has a "Wallet" header column.
    // All 300 must render — a 250-cap would drop 50 (the lowest-serial wallets).
    const holderTable = [...container.querySelectorAll("table")].find((t) =>
      (t.textContent ?? "").includes("Wallet"),
    )
    const bodyRows = holderTable?.querySelectorAll("tbody tr") ?? []
    expect(bodyRows.length).toBe(300)
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

// Remaining dark branches on the ~600-line board: the coverage-banner traded/untraded
// split, the excluded-troll note (both plurals), the pack-market fallback copy when a
// multiple is absent, the market slice note, the Spread column's client-side below-ask
// computation (normal / crossed / missing legs) driven through DataTable's `sv` sort,
// the Deals singular tooltip, a generic string-column sort, and the parallel-less Players tab.
describe("CandyBoardClient — coverage banner + market notes", () => {
  it("states the traded-vs-untraded split when some editions have no FMV", () => {
    const { container } = mount({
      initialRows: [marketRows[0], { ...marketRows[0], external_id: "cold", player_name: "Cold Guy", fmv_usd: null }],
    })
    const cov = container.querySelector(".cdy-cov")?.textContent ?? ""
    expect(cov).toMatch(/Only/)
    expect(cov).toMatch(/rather than a guess/i)
  })

  it("notes excluded troll listings (plural) on the Market tab", () => {
    const { container } = mount({ initialRows: [{ ...marketRows[0], excluded_troll_count: 3 }] })
    expect(container.textContent).toMatch(/3 outlier listings/i)
  })

  it("uses the singular 'listing' when exactly one outlier is excluded", () => {
    const { container } = mount({ initialRows: [{ ...marketRows[0], excluded_troll_count: 1 }] })
    const text = container.textContent ?? ""
    expect(text).toMatch(/1 outlier listing\b/i)
    expect(text).not.toMatch(/1 outlier listings/i)
  })

  it("reports the slice when market matches exceed the render cap", () => {
    const big = Array.from({ length: 305 }, (_, i) => ({
      ...marketRows[0], external_id: `e${i}`, player_name: `P${i}`, fmv_usd: 1000 - i,
    }))
    const { container } = mount({ initialRows: big })
    expect(container.querySelectorAll("tbody tr")).toHaveLength(300)
    expect(container.textContent).toMatch(/Showing\s+300\s+of\s+305/)
  })
})

describe("CandyBoardClient — pack market fallback copy", () => {
  const packMarket = {
    median_7d_usd: 33.78,
    median_vs_retail_x: null,
    median_vs_typical_pull_x: null,
    retail_usd: 10,
    sales_all: 1,
  }

  it("falls back to 'above cost' when the retail multiple is absent, and singularises one sale", () => {
    const { container } = mount({ packMarket })
    const text = container.textContent ?? ""
    // median_vs_retail_x null → "(above $10 cost)" rather than "(3.38× the $10 cost)"
    expect(text).toMatch(/\(above/)
    expect(text).toMatch(/Packs actually sell for/)
    // sales_all === 1 → "recorded sale" (no trailing s)
    expect(text).toMatch(/recorded sale\b/)
  })
})

// D33 (2026-08-09). The Spread tab used to render (floor_usd - best_offer_usd),
// subtracting an EDITION-grain ask from a MINT-grain bid — two different NFTs on
// 94% of live rows, and negative on 21% of them. These tests pin the replacement:
// the executable spread renders ONLY on the floor copy, a cross-copy row is
// marked and left blank, and the old fabricated figure must never come back.
describe("CandyBoardClient — Spread tab quotes only same-copy spreads", () => {
  const spreadsMixed = [
    // Cheapest listed copy carries its own bid → a real, executable spread.
    { external_id: "s1", player_name: "SameCopy", edition_name: "SameCopy", best_offer_usd: 3,
      distinct_bidders: 2, floor_usd: 5, fmv_usd: 6,
      same_copy: true, floor_copy_bid_usd: 3, exec_spread_usd: 2, exec_spread_pct: 40 },
    // The live shape of the defect: a bid ABOVE the floor ask, on a different
    // copy. It must render no percentage at all — the old code showed "0.0%".
    { external_id: "s2", player_name: "OtherCopy", edition_name: "OtherCopy", best_offer_usd: 57.31,
      distinct_bidders: 1, floor_usd: 4.63, fmv_usd: 6,
      same_copy: false, floor_copy_bid_usd: null, exec_spread_usd: null, exec_spread_pct: null },
    // An older CACHED snapshot, predating the new fields entirely. Must stay
    // fail-soft: render the row, claim nothing, and show no ≠ copy chip.
    { external_id: "s3", player_name: "Cached", edition_name: "Cached", best_offer_usd: 2,
      distinct_bidders: 1, floor_usd: null, fmv_usd: 6 },
  ]

  it("renders the executable spread, blanks a cross-copy row, and marks it ≠ copy", () => {
    const { container } = mount({ spreads: spreadsMixed })
    fireEvent.click(tabButton(container, "Spread"))
    const text = container.textContent ?? ""

    expect(text).toMatch(/40\.0%/) // (5 - 3) / 5 on one copy
    expect(text).toMatch(/≠ copy/) // the cross-copy row is labelled

    // The cross-copy row shows its two floors but NO spread between them.
    // Scoped to the row on purpose: a global /0\.0%/ would also match inside
    // the legitimate "40.0%" one row above it.
    const otherRow = [...container.querySelectorAll("tbody tr")].find((r) =>
      (r.textContent ?? "").includes("OtherCopy"),
    ) as HTMLElement
    expect(otherRow.textContent).toMatch(/—/)
    // The fabricated figure is gone: a bid $52.68 OVER the ask must produce no
    // percentage at all here. Old renders were "0.0%" (clamped) and "-91.9%".
    expect(otherRow.textContent).not.toMatch(/%/)

    // And no negative percentage anywhere on the tab.
    expect(text).not.toMatch(/-\d+(\.\d)?%/)

    expect(text).toMatch(/Cached/) // pre-migration cached row still renders
  })

  it("sorts by the same field it displays", () => {
    const { container } = mount({ spreads: spreadsMixed })
    fireEvent.click(tabButton(container, "Spread"))
    const th = [...container.querySelectorAll("thead th")].find((h) =>
      (h.textContent ?? "").startsWith("Spread (same copy)"),
    ) as HTMLElement
    expect(th).toBeTruthy()
    fireEvent.click(th)
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3)
  })
})

describe("CandyBoardClient — generic DataTable string sort", () => {
  it("sorts a string column and toggles direction without dropping rows", () => {
    const { container } = mount({
      holders: [
        { wallet_address: "0xbbbb1111", serials: 1, editions: 1, priced_serials: 1, est_fmv_usd: 1 },
        { wallet_address: "0xaaaa2222", serials: 2, editions: 1, priced_serials: 1, est_fmv_usd: 1 },
      ],
    })
    fireEvent.click(tabButton(container, "Holders"))
    const walletTh = [...container.querySelectorAll("thead th")].find((h) =>
      (h.textContent ?? "").startsWith("Wallet"),
    ) as HTMLElement
    fireEvent.click(walletTh) // string sort, desc
    fireEvent.click(walletTh) // toggle asc
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2)
  })
})

describe("CandyBoardClient — Deals singular tooltip + parallel-less Players", () => {
  const dealRow = {
    pda_address: "pda1", external_id: "walker", player_name: "Jordan Walker", edition_name: "Jordan Walker",
    tier: "COMMON", is_rainbow: false, serial_number: 243, ask_usd: 5, fmv_usd: 10,
    discount_pct: 50, median_sale_usd: 5, sales_count: 1, discount_vs_median_pct: 10,
  }

  it("uses singular 'sale' in the vs-median tooltip when one sale backs it", () => {
    const { container } = mount({ deals: [dealRow] })
    fireEvent.click(tabButton(container, "Deals"))
    const titles = [...container.querySelectorAll("tbody td span[title]")].map((s) => s.getAttribute("title") ?? "")
    expect(titles.some((t) => /median of 1 sale\b/.test(t))).toBe(true)
  })

  it("hides the Core/Rainbow rollup when parallel data is absent", () => {
    const { container } = mount({
      parallel: [],
      players: [{ player_name: "Solo", team_name: "KC", editions: 1, priced: 1, avg_fmv: 5, top_fmv: 5, sales_all: 1 }],
    })
    fireEvent.click(tabButton(container, "Players"))
    expect(container.textContent).not.toMatch(/Core ICON/)
    expect(container.textContent).toMatch(/Per-player rollup/i)
    expect(container.textContent).toMatch(/Solo/)
  })
})
