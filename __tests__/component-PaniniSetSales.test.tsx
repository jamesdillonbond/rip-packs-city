// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * The Panini set page's Sales section (2026-09-30). Stated as the ABSENCE of the false claims:
 * a failed read is never "no sales" or $0, and a set whose editions are not all on record never
 * shows its 30-day counts as totals.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniSetSalesBody from "@/components/entity/PaniniSetSales"
import type { PaniniSetSales } from "@/lib/panini/set-sales"

const DATA: PaniniSetSales = {
  top: [{ editionKey: "packcard-2332_486967_12675075_10", playerName: "Lionel Messi", serial: 10, mintCap: 259, amountUsd: 6000, soldAt: "2026-09-12T00:13:01Z" }],
  recent: [{ editionKey: "packcard-2120_413399_11204852_172", playerName: "Victor Wembanyama", serial: 27, mintCap: 424, amountUsd: 69, soldAt: "2026-09-29T05:33:01Z" }],
  editions: 612,
  editionsRead: 53,
  window30d: { sales: 3563, volumeUsd: 20995, medianUsd: 2, editionsTraded: 403 },
}
afterEach(cleanup)

describe("PaniniSetSalesBody", () => {
  it("a failed read says couldn't load — no counts, no $0, no 'no sale'", () => {
    const c = render(<PaniniSetSalesBody collection="panini-blockchain" res={null} />).container
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("does not mean the set has no sales")
    expect(c.textContent).not.toMatch(/\$0\b|No sale|Sales · 30 days/)
  })

  it("partial coverage reads the 30-day counts as floors and says how many editions are on record", () => {
    const c = render(<PaniniSetSalesBody collection="panini-blockchain" res={DATA} />).container
    const summary = c.querySelector('[data-testid="panini-set-sales-summary"]')!.textContent!
    expect(summary).toContain("≥ 3,563")
    expect(summary).toContain("≥ $20,995")
    expect(summary).not.toMatch(/(?<!≥ )3,563/)
    expect(c.textContent).toContain("53 of them with every sale on record")
  })

  it("control: a fully covered set shows its counts without a floor", () => {
    const c = render(<PaniniSetSalesBody collection="panini-blockchain" res={{ ...DATA, editionsRead: 612 }} />).container
    const summary = c.querySelector('[data-testid="panini-set-sales-summary"]')!.textContent!
    expect(summary).toContain("3,563")
    expect(summary).not.toContain("≥")
  })

  it("lists link each sale to its edition page with the serial; no buyer or seller is shown", () => {
    const c = render(<PaniniSetSalesBody collection="panini-blockchain" res={DATA} />).container
    const a = c.querySelector('a[href="/panini-blockchain/edition/packcard-2332_486967_12675075_10"]')
    expect(a?.textContent).toContain("Lionel Messi · #10/259")
    expect(a?.textContent).toContain("$6,000")
    expect(c.textContent).not.toMatch(/buyer|seller/i)
  })

  it("control: an empty list says nothing is on record YET — only when the read succeeded", () => {
    const c = render(<PaniniSetSalesBody collection="panini-blockchain" res={{ ...DATA, top: [], recent: [] }} />).container
    expect(c.textContent).toContain("No sale of this set’s cards on record yet.")
  })
})
