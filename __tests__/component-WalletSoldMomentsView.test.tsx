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

  it("surfaces a load error", async () => {
    ownerKey = "0xowner"
    fetchMock = vi.fn(() => res(500, { error: "history down" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("history down")).toBeTruthy())
  })
})
