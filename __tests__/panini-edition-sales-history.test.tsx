// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"

/**
 * Edition-page Panini sales history (2026-09-28): the 30-day count is COMPLETE only when the
 * edition's coverage AND this read both reach back 30 days; otherwise "at least". The chart
 * shades the span before complete_since so missing sales never read as a quiet period.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
import { summarizeEditionSales, type PaniniEditionSales, type PaniniEditionSale } from "@/lib/panini/edition-market"
import PaniniSalesChart from "@/components/entity/PaniniSalesChart"

const NOW = Date.parse("2026-09-29T12:00:00Z")
const day = 86_400_000
const sale = (daysAgo: number, usd: number, serial = 1): PaniniEditionSale => ({
  sku: `p__${serial}_10`, serial, mintCap: 10, amountUsd: usd, soldAt: new Date(NOW - daysAgo * day).toISOString(), flags: [],
})
const hist = (sales: PaniniEditionSale[], coverage: PaniniEditionSales["coverage"]): PaniniEditionSales => ({ sales, totalOnRecord: sales.length, coverage })

describe("summarizeEditionSales", () => {
  it("whole history on record → the 30-day count is complete, with its median", () => {
    const s = summarizeEditionSales(hist([sale(1, 10), sale(5, 30), sale(40, 999)], { kind: "all", lastReadAt: null }), NOW)
    expect(s).toEqual({ sales30d: 2, median30dUsd: 20, complete30d: true })
  })
  it("coverage that starts inside the window → 'at least'", () => {
    const since = new Date(NOW - 10 * day).toISOString()
    expect(summarizeEditionSales(hist([sale(1, 10)], { kind: "since", since, lastReadAt: null }), NOW)?.complete30d).toBe(false)
  })
  it("control: coverage that starts before the window → complete", () => {
    const since = new Date(NOW - 45 * day).toISOString()
    expect(summarizeEditionSales(hist([sale(1, 10)], { kind: "since", since, lastReadAt: null }), NOW)?.complete30d).toBe(true)
  })
  it("never read, or coverage unknown (a failed read) → 'at least', never complete", () => {
    expect(summarizeEditionSales(hist([sale(1, 10)], { kind: "unread" }), NOW)?.complete30d).toBe(false)
    expect(summarizeEditionSales(hist([sale(1, 10)], null), NOW)?.complete30d).toBe(false)
  })
  it("a read that hit its 200-row limit inside the window cannot be complete", () => {
    const many = Array.from({ length: 200 }, (_, i) => sale(i * 0.1, 5, (i % 10) + 1))
    expect(summarizeEditionSales(hist(many, { kind: "all", lastReadAt: null }), NOW)?.complete30d).toBe(false)
  })
  it("a failed sales read summarizes to null — no count at all", () => {
    expect(summarizeEditionSales({ sales: null, totalOnRecord: null, coverage: { kind: "all", lastReadAt: null } }, NOW)).toBeNull()
  })
})

describe("PaniniSalesChart", () => {
  it("plots one dot per sale with a tooltip, and shades the partial span before complete_since", () => {
    const sales = [sale(1, 10, 3), sale(20, 30, 1), sale(60, 12, 2)]
    const since = new Date(NOW - 30 * day).toISOString()
    const c = render(<PaniniSalesChart sales={sales} coverage={{ kind: "since", since, lastReadAt: null }} />).container
    expect(c.querySelectorAll("circle")).toHaveLength(3)
    expect(c.querySelector("circle title")?.textContent).toMatch(/\$10 · .* · #3\/10/)
    expect(c.textContent).toContain("partial before")
  })
  it("control: whole history on record draws no partial shading", () => {
    const c = render(<PaniniSalesChart sales={[sale(1, 10), sale(20, 30)]} coverage={{ kind: "all", lastReadAt: null }} />).container
    expect(c.textContent).not.toContain("partial before")
  })
  it("fewer than two sales draws nothing (a single dot is not a history)", () => {
    expect(render(<PaniniSalesChart sales={[sale(1, 10)]} coverage={null} />).container.innerHTML).toBe("")
  })
  it("prices spanning >20x switch to a log axis and say so", () => {
    const c = render(<PaniniSalesChart sales={[sale(1, 3), sale(2, 900)]} coverage={null} />).container
    expect(c.textContent).toContain("logarithmic")
  })
})
