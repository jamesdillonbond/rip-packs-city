// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react"

// Pins the Net Marketplace leaderboard's money + net-position display — the
// fmtUsd banding ($M/$k/$/cents, sign-preserving) and the net-seller(green)/
// net-buyer(red)/flat(muted) coloring that IS the table's meaning. A formatter
// or sign regression here silently mislabels who is accumulating vs offloading.
// Rendered via the DOM with fetch + the username-resolver hook stubbed (no
// source change).
//
// INVERTED 2026-10-10 (#178): net_position_usd is sell - buy in the SQL
// (flowty_top_net_marketplace: COALESCE(sells) - COALESCE(buys); verified on
// Flowty's final week, where a wallet with 2 sells / 0 buys reads +5,899). The
// previous pin asserted the component's own comment ("negative = net seller"),
// i.e. the defect, and held every net seller red for the panel's whole life.
// A positive net is a NET SELLER (green, shown with a leading +); a negative
// net is a NET BUYER (red).

vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => ({ "0xseller": "whale" }),
}))
vi.mock("@/components/analytics/WalletIdenticon", () => ({
  default: () => null,
}))

import NetMarketplaceLeaderboard from "@/components/analytics/NetMarketplaceLeaderboard"

const row = (over: Record<string, any>) => ({
  rank: 1,
  address: "0xseller",
  gross_activity_usd: 1_500_000,
  net_position_usd: 2000, // net seller (sell - buy > 0)
  buy_tx_count: 3,
  buy_volume_usd: 150,
  sell_tx_count: 9,
  sell_volume_usd: 2.5,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) }) as any)
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NetMarketplaceLeaderboard", () => {
  it("renders the empty state when there is no activity in the window", async () => {
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(screen.getByText(/No Flowty marketplace activity/i)).toBeTruthy())
  })

  it("formats gross with $M banding and colors a net seller (positive net) green with a leading +", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [row({})] }) } as any)
    render(<NetMarketplaceLeaderboard />)
    // Gross 1_500_000 -> $1.50M
    await waitFor(() => expect(screen.getByText("$1.50M")).toBeTruthy())
    // net +2000 (sold more than bought) -> +$2.0k, colored success (net seller)
    const net = screen.getByText("+$2.0k")
    expect(net.getAttribute("style") || "").toContain("var(--rpc-success)")
    expect(net.getAttribute("style") || "").not.toContain("var(--rpc-danger)")
    // username resolved to @whale (lowercased lookup)
    expect(screen.getByText("@whale")).toBeTruthy()
  })

  it("colors a net buyer (negative net) red with no + sign", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [row({ address: "0xbuyer0000000001", net_position_usd: -3400 })] }),
    } as any)
    render(<NetMarketplaceLeaderboard />)
    // net -3400 (bought more than sold) -> "-$3.4k", colored danger, no leading +
    await waitFor(() => expect(screen.getByText("-$3.4k")).toBeTruthy())
    const netCell = screen.getByText("-$3.4k").closest("td")!
    expect(netCell.textContent).not.toContain("+")
    expect(netCell.getAttribute("style") || "").toContain("var(--rpc-danger)")
    // no resolved username for this address -> truncated 0x…tail
    expect(screen.getByText("0xbuye…0001")).toBeTruthy()
  })

  it("names the archive window only off a response that carries it", async () => {
    // A bare response (no as_of/archived) must not invent a close date.
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/final 30 days/i)).toBeNull()
    cleanup()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ as_of: "2026-05-14", archived: true, rows: [row({})] }),
    } as any)
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(screen.getByText(/final 30 days of trading \(to 14 May 2026\)/i)).toBeTruthy())
  })

  it("colors a flat net (0) muted", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [row({ address: "0xflat0000000001", net_position_usd: 0, gross_activity_usd: 42000, buy_volume_usd: 150, sell_volume_usd: 2.5 })],
      }),
    } as any)
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(screen.getByText("$42.0k")).toBeTruthy())
    // net 0 -> the only "$0" on the row, colored muted (fmtUsd(0) === "$0")
    const zero = screen.getByText("$0")
    expect(zero.getAttribute("style") || "").toContain("var(--rpc-text-muted)")
  })

  it("refetches with the selected window when a day toggle is clicked", async () => {
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain("days=30") // default
    fireEvent.click(screen.getByRole("button", { name: "7d" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain("days=7")
  })

  it("refetches scoped to a collection when its chip is clicked", async () => {
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Top Shot" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain("collection=topshot")
  })

  it("does not crash on a non-ok fetch, and does not call the market idle", async () => {
    // This assertion used to read `/No Flowty marketplace activity/`, i.e. it
    // pinned the failure rendering as a market finding. The no-crash intent is
    // kept; the claim is now the thing being ruled out.
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as any)
    render(<NetMarketplaceLeaderboard />)
    await waitFor(() => expect(screen.getByText(/Couldn't load marketplace activity/i)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/No Flowty marketplace activity/i)
  })
})
