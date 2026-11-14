// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import WalletSoldMomentsView from "@/components/collection/WalletSoldMomentsView"

// Drives the "Sold" body under the Collection tab: the wallet-resolution gate
// (no wallet → CTA, no fetch), the 401/403 → verify/sign-in branch, the loaded
// state (Moments sold count + Total proceeds + the client-side collection filter
// over /api/wallet/transaction-history), and the empty/error states. The pure
// format/filter helpers (fmtSoldUsd/filterSoldEventsByCollection/...) are tested
// separately (collection-sold-moments-format).

let urlWallet: string | null = null
let ownerKey = ""
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => (k === "wallet" ? urlWallet : null) }),
}))
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => ownerKey }))

let fetchMock: ReturnType<typeof vi.fn>
const res = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response)

const sell = {
  kind: "sell",
  nft_id: "42",
  title: "Damian Lillard — Logo Daze",
  subtitle: "Series 4",
  thumbnail_url: null,
  serial_number: 7,
  amount_usd: 1250,
  currency: "USD",
  occurred_at: "2026-04-01T00:00:00Z",
  counterparty: "0xbuyerbuyerbuyer1",
  collection_slug: "nba_top_shot", // must match toDbSlug("nba-top-shot")
}

beforeEach(() => {
  urlWallet = null
  ownerKey = ""
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("WalletSoldMomentsView", () => {
  it("renders the no-wallet CTA and fetches nothing", () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    expect(getByText("Moments you've sold")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the sign-in/verify branch on 401", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(401, {}))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Sign in to see sold moments")).toBeTruthy())
  })

  it("a 403 (signed in, not your saved wallet) says so instead of 'Sign in' (2026-11-07)", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(403, {}))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Sale history is for your own wallet")).toBeTruthy())
  })

  it("renders the sold count, proceeds, and a filtered row", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(200, { events: [sell], total_count: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, getAllByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Damian Lillard — Logo Daze")).toBeTruthy())
    expect(getByText("1")).toBeTruthy() // moments sold count
    expect(getByText("#7")).toBeTruthy() // serial
    // proceeds + sale price both render the $1,250 total (via fmtSoldUsd)
    expect(getAllByText("$1,250.00").length).toBeGreaterThanOrEqual(2)
    expect(fetchMock.mock.calls[0][0]).toContain("kind=sells")
  })

  it("shows the empty state when the wallet has no sales in this collection", async () => {
    ownerKey = "0xowner"
    // an event for a DIFFERENT collection is filtered out client-side
    fetchMock = vi.fn(() => res(200, { events: [{ ...sell, collection_slug: "ufc_strike" }], total_count: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText(/No moments sold from this wallet/)).toBeTruthy())
  })

  it("counts moment sales only — a pack sale is not a sold moment (2026-11-14)", async () => {
    ownerKey = "0xowner"
    const packSale = { ...sell, kind: "pack_sell", nft_id: "999", title: null, amount_usd: 50000 }
    fetchMock = vi.fn(() => res(200, { events: [packSale, sell], total_count: 2 }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText, getAllByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Damian Lillard — Logo Daze")).toBeTruthy())
    expect(queryByText("Moment #999")).toBeNull()
    expect(getByText("1")).toBeTruthy()
    expect(getAllByText("$1,250.00").length).toBeGreaterThanOrEqual(2)
    expect(queryByText("$51,250.00")).toBeNull()
  })

  it("reads every page before concluding there are none in this collection (2026-11-14)", async () => {
    ownerKey = "0xowner"
    const other = Array.from({ length: 200 }, (_, i) => ({ ...sell, nft_id: String(i), collection_slug: "nfl_all_day" }))
    fetchMock = vi.fn((url: string) =>
      url.includes("offset=0")
        ? res(200, { events: other, total_count: 201 })
        : res(200, { events: [sell], total_count: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Damian Lillard — Logo Daze")).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain("offset=200")
    expect(queryByText(/No moments sold from this wallet/)).toBeNull()
  })

  it("at the page cap it marks a floor and does not conclude 'none' (2026-11-14)", async () => {
    ownerKey = "0xowner"
    const other = Array.from({ length: 200 }, (_, i) => ({ ...sell, nft_id: String(i), collection_slug: "nfl_all_day" }))
    fetchMock = vi.fn(() => res(200, { events: other, total_count: 5000 }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText(/most recent sales; older ones were not loaded/)).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(queryByText(/No moments sold from this wallet in/)).toBeNull()
    expect(getByText("0+")).toBeTruthy()
  })

  it("a failed later page fails the read rather than showing the first page (2026-11-14)", async () => {
    ownerKey = "0xowner"
    const page = Array.from({ length: 200 }, (_, i) => ({ ...sell, nft_id: String(i) }))
    fetchMock = vi.fn((url: string) =>
      url.includes("offset=0") ? res(200, { events: page, total_count: 400 }) : res(500, { error: "history down" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("history down")).toBeTruthy())
    expect(queryByText("200")).toBeNull()
  })

  it("surfaces a load error", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(500, { error: "history down" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("history down")).toBeTruthy())
  })

  // 2026-10-11: a failed read must not publish "0 sold / $0.00 proceeds" in the
  // KPI cards above the error — assert the ABSENCE of the false claim.
  it("does not render a measured zero in the KPI cards when the read failed", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(500, { error: "history down" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText, getAllByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("history down")).toBeTruthy())
    expect(queryByText("0")).toBeNull()
    expect(queryByText("$0.00")).toBeNull()
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2)
  })
})
