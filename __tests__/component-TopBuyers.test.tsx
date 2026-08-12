// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import TopBuyers from "@/components/analytics/TopBuyers"

// Drives the Top Accumulators leaderboard end-to-end: it fetches
// /api/analytics/top-buyers, shows a skeleton, then either an empty state or a
// ranked table with fmt() money ($k/$M), a shortened/username-resolved wallet
// label, and the sweep highlight. The money + address formatting is the
// regression surface (a broken fmt renders "$NaN" on a public analytics board).

vi.mock("@/lib/analytics/username-resolver", () => ({
  // deterministic: resolve one address to a handle, leave others bare
  useResolveUsernames: () => ({ "0xaaaaaaaaaaaaaaaa": "whale" }),
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const rowFixture = [
  {
    rank: 1,
    buyer_address: "0xaaaaaaaaaaaaaaaa",
    buy_count: 12,
    spend_usd: 1_500_000, // → $1.5M
    avg_price_usd: 125_000,
    distinct_editions: 3,
    top_edition_id: "e1",
    top_edition_buys: 5, // >= SWEEP_THRESHOLD → sweep highlight
    top_edition_player: "Dame",
    top_edition_set: "Base",
  },
  {
    rank: 2,
    buyer_address: "0xbbbbbbbbbbbbbbbb",
    buy_count: 3,
    spend_usd: 2_500, // → $2.5k
    avg_price_usd: 833,
    distinct_editions: 2,
    top_edition_id: null,
    top_edition_buys: 1,
  },
]

describe("TopBuyers (Top Accumulators)", () => {
  it("renders the ranked table with formatted money and a resolved handle", async () => {
    fetchMock.mockReturnValue(okJson({ rows: rowFixture }))
    const { container } = render(<TopBuyers collection="nba_top_shot" />)
    await waitFor(() => expect(container.textContent).toContain("$1.5M"))
    expect(container.textContent).toContain("$2.5k")
    // the first buyer's address resolved to a handle via the mocked resolver
    expect(container.textContent).toContain("@whale")
    // the second buyer stays a shortened address
    expect(container.textContent).toContain("0xbbbb…bbbb")
  })

  it("shows the empty state when no rows come back", async () => {
    fetchMock.mockReturnValue(okJson({ rows: [] }))
    const { container } = render(<TopBuyers collection="nba_top_shot" />)
    await waitFor(() => expect(container.textContent).toContain("No buyer-resolved accumulation"))
  })

  // Both of these used to assert "No buyer-resolved accumulation" — the two
  // failure paths (!r.ok and the catch) each called setRows([]), so a failure
  // was indistinguishable from a real absence BY CONSTRUCTION. The no-crash
  // intent is kept and the finding is now what gets ruled out.
  it("does not report an absence of accumulation on a non-ok response", async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, json: () => Promise.resolve(null) } as Response))
    const { container } = render(<TopBuyers collection="nba_top_shot" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't load buyer accumulation"))
    expect(container.textContent).not.toContain("No buyer-resolved accumulation")
  })

  it("does not report an absence of accumulation when fetch rejects", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("network")))
    const { container } = render(<TopBuyers collection="nba_top_shot" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't load buyer accumulation"))
    expect(container.textContent).not.toContain("No buyer-resolved accumulation")
  })

  it("requests the given collection and default 7d window", async () => {
    fetchMock.mockReturnValue(okJson({ rows: [] }))
    render(<TopBuyers collection="nfl_all_day" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain("collection=nfl_all_day")
    expect(url).toContain("days=7")
  })
})
