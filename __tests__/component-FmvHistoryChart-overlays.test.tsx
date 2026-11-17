// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

// The chart overlays (beta feedback 10259 / 10261 / 10263, 2026-10-03): opt-in
// chips, off by default, each drawn from data RPC actually keeps and named in
// the caption. Pinned here:
//   · nothing is overlaid until a chip is pressed, and the caption says which
//   · ASP is an FMV-range overlay only (the long ranges plot the median print)
//   · RANGE / VOLUME on an FMV range fetch the per-day sale prints (sale-history)
//   · MY BUYS appears only when the site tracks a wallet, fetches by that wallet,
//     and an empty answer is said plainly (never a silent nothing)
//   · the moving average is honest about a short window at the start
//   · no "ask history" / "offer history" chip exists — RPC keeps no such series

import FmvHistoryChart, { trailingAverage } from "@/components/entity/FmvHistoryChart"

const fmvPt = (fmv: number, day: string) => ({
  day, fmv_usd: fmv, wap_usd: fmv - 1, floor_usd: fmv,
  confidence: "HIGH", sales_count_30d: 3, computed_at: day,
})
const initial = [fmvPt(10, "2026-07-01"), fmvPt(11, "2026-07-02"), fmvPt(12, "2026-07-03"), fmvPt(13, "2026-07-04")]

let fetchMock: any
beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    if (String(url).includes("part=sale-history")) return Promise.resolve({ ok: true, json: async () => [{ bucket: "2026-07-02", median_usd: 11, low_usd: 9, high_usd: 14, sales_count: 4, grain: "day" }] } as Response)
    if (String(url).includes("part=wallet-purchases")) return Promise.resolve({ ok: true, json: async () => [{ sold_at: "2026-07-03T10:00:00Z", price_usd: 12.5, serial_number: 7, marketplace: "topshot" }] } as Response)
    return Promise.resolve({ ok: true, json: async () => [] } as Response)
  })
  vi.stubGlobal("fetch", fetchMock)
  window.localStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const calls = (): string[] => fetchMock.mock.calls.map((c: any[]) => String(c[0]))
const renderChart = () => render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="272:9030" initial={initial} />)

describe("FmvHistoryChart — overlays", () => {
  it("starts with every overlay off and no fetch beyond the seeded view", () => {
    const { container } = renderChart()
    const group = screen.getByRole("group", { name: "Chart overlays" })
    for (const b of group.querySelectorAll("button")) expect(b.getAttribute("aria-pressed")).toBe("false")
    expect(container.textContent).toContain("ESTIMATED FMV · DAILY")
    expect(container.textContent).not.toMatch(/ASP 30D|LOW–HIGH PRINTS|SALES\/BUCKET|MA 7 ·|MY BUYS/)
    expect(calls()).toHaveLength(0)
  })

  it("offers ASP, RANGE, VOLUME and MA — and no ask-history / offer-history chip, which RPC has no series for", () => {
    renderChart()
    const names = [...screen.getByRole("group", { name: "Chart overlays" }).querySelectorAll("button")].map(b => b.textContent)
    expect(names).toEqual(["ASP", "RANGE", "VOLUME", "MA 7"])
    expect(names.join(" ")).not.toMatch(/ask|offer/i)
  })

  it("RANGE on an FMV range fetches the per-day sale prints and names the overlay in the caption; it is not called candlesticks", async () => {
    const { container } = renderChart()
    fireEvent.click(screen.getByRole("button", { name: "RANGE" }))
    await waitFor(() => expect(calls().some(u => u.includes("part=sale-history") && u.includes("days=30"))).toBe(true))
    expect(container.textContent).toContain("LOW–HIGH PRINTS")
    expect(screen.getByRole("button", { name: "RANGE" }).getAttribute("title")).toMatch(/Not candlesticks/)
  })

  it("MY BUYS exists only when the site tracks a wallet, fetches by that wallet, and says plainly when there are none", async () => {
    renderChart()
    expect(screen.queryByRole("button", { name: "MY BUYS" })).toBeNull()
    cleanup()
    window.localStorage.setItem("rpc_wallet_address", "0x17fa19ec950ace75")
    const { container } = renderChart()
    const chip = await screen.findByRole("button", { name: "MY BUYS" })
    fireEvent.click(chip)
    await waitFor(() => expect(calls().some(u => u.includes("part=wallet-purchases") && u.includes("wallet=0x17fa19ec950ace75"))).toBe(true))
    await waitFor(() => expect(container.textContent).toContain("MY BUYS"))
    // an empty answer is stated, never silent
    cleanup()
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] } as Response))
    const r2 = renderChart()
    fireEvent.click(await screen.findByRole("button", { name: "MY BUYS" }))
    await waitFor(() => expect(r2.container.querySelector('[data-testid="buys-empty"]')?.textContent).toMatch(/No recorded purchases of this edition for 0x17fa…ce75/))
  })

  it("a failed overlay read is said, and is not 'no sales' / 'no buys'", async () => {
    window.localStorage.setItem("rpc_wallet_address", "0x17fa19ec950ace75")
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response))
    const { container } = renderChart()
    fireEvent.click(screen.getByRole("button", { name: "VOLUME" }))
    await waitFor(() => expect(container.textContent).toMatch(/Couldn.t load the sale prints/))
    fireEvent.click(await screen.findByRole("button", { name: "MY BUYS" }))
    await waitFor(() => expect(container.textContent).toMatch(/Couldn.t load your purchases/))
    expect(container.querySelector('[data-testid="buys-empty"]')).toBeNull()
  })

  it("ASP is offered on the FMV ranges only (the long ranges already plot the median print)", async () => {
    renderChart()
    expect(screen.getByRole("button", { name: "ASP" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "1Y" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "ASP" })).toBeNull())
  })
})

describe("trailingAverage", () => {
  it("averages up to seven trailing points and reports the window it actually used", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    expect(trailingAverage(v, 0)).toEqual({ avg: 1, window: 1 })
    expect(trailingAverage(v, 2)).toEqual({ avg: 2, window: 3 })
    expect(trailingAverage(v, 8)).toEqual({ avg: 6, window: 7 })
  })
})
