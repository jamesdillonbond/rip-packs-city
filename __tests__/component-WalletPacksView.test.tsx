// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import WalletPacksView from "@/components/packs/WalletPacksView"

// Drives the collection-scoped Packs body: the wallet-resolution gate (no wallet
// → CTA, no fetch), the auth-required 401/403 branch (pack P&L is signed-in), the
// summary hero + history table (status chip, has_buy/sell/rip "—" gating, net P&L
// from the matched collection row), the Unopened/Opened/Sold sub-filter that
// re-fetches with the mapped p_status, and the empty/error states. The pure
// format helpers (fmtPackUsd etc.) are tested separately.

let urlWallet: string | null = null
let ownerKey = ""
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => (k === "wallet" ? urlWallet : null) }),
}))
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => ownerKey }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

let fetchMock: ReturnType<typeof vi.fn>
const res = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response)

// Route the two parallel fetches by URL so summary/history stay independent.
function routeFetch(handlers: { summary: () => Promise<Response>; history: (url: string) => Promise<Response> }) {
  return vi.fn((url: string) =>
    url.includes("pack-summary") ? handlers.summary() : handlers.history(url),
  )
}

const summaryBody = {
  wallet: "0xabc",
  by_collection: [
    {
      collection_id: "cid",
      collection_name: "NBA Top Shot",
      collection_slug: "nba_top_shot", // must match toDbSlug("nba-top-shot")
      spent_usd: 250,
      proceeds_usd: 0,
      ripped_value_usd: 300,
      net_pl_usd: 50,
      activity_total: 5,
      packs_purchased: 5,
      packs_ripped: 3,
      packs_sold: 0,
    },
  ],
}
const heldRow = {
  pack_nft_id: "999888777",
  dist_id: null,
  pack_name: "Base Pack",
  pack_image: null,
  collection_slug: "nba_top_shot",
  status: "held" as const,
  has_buy: false,
  has_rip: false,
  has_sell: false,
  buy_price: null,
  buy_currency: null,
  sell_price: null,
  pull_value_usd: null,
  realized_pl_usd: null,
  latest_event_at: null,
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

describe("WalletPacksView", () => {
  it("renders the no-wallet CTA and fetches nothing when no wallet resolves", () => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    expect(getByText("Your sealed packs")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the sign-in branch when pack P&L returns 401/403", async () => {
    ownerKey = "0xdead"
    fetchMock = routeFetch({ summary: () => res(401, {}), history: () => res(403, {}) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Sign in to see pack P&L")).toBeTruthy())
  })

  it("renders the hero stats + a history row with has_* gated '—' cells", async () => {
    ownerKey = "0xowner"
    fetchMock = routeFetch({
      summary: () => res(200, summaryBody),
      history: () => res(200, { packs: [heldRow], total_count: 1 }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, getAllByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Base Pack")).toBeTruthy())
    // hero: packs purchased 5, total spent $250.00, ripped $300.00, net $50.00
    // (fmtPackUsd renders 2 dp under $1000)
    expect(getByText("5")).toBeTruthy()
    expect(getByText("$250.00")).toBeTruthy()
    expect(getByText("$300.00")).toBeTruthy()
    expect(getByText("$50.00")).toBeTruthy()
    // held status chip
    expect(getByText("held")).toBeTruthy()
    // has_buy/has_sell/has_rip all false → three "—" cells + realized P&L "—"
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(3)
  })

  it("the Opened sub-filter re-fetches pack-history with status=ripped", async () => {
    ownerKey = "0xowner"
    const historyUrls: string[] = []
    fetchMock = routeFetch({
      summary: () => res(200, summaryBody),
      history: (url) => {
        historyUrls.push(url)
        return res(200, { packs: [heldRow], total_count: 1 })
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(historyUrls.length).toBe(1))
    expect(historyUrls[0]).toContain("status=held") // default = unopened

    fireEvent.click(getByText("Opened"))
    await waitFor(() => expect(historyUrls.length).toBe(2))
    expect(historyUrls[1]).toContain("status=ripped")
    expect(historyUrls[1]).toContain("collection=nba_top_shot")
  })

  it("ignores a stale pack-history response that resolves after a newer filter switch", async () => {
    ownerKey = "0xowner"
    // Deferred history responses so we can resolve them out of order. Summary
    // resolves immediately; the assertion is about which HISTORY response wins.
    const deferred: Array<{ url: string; resolve: (r: Response) => void }> = []
    fetchMock = routeFetch({
      summary: () => res(200, summaryBody),
      history: (url) =>
        new Promise<Response>((resolve) => {
          deferred.push({ url, resolve })
        }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText } = render(<WalletPacksView collection="nba-top-shot" />)

    // Initial load (held). Resolve it so the board renders and tabs are clickable.
    await waitFor(() => expect(deferred.length).toBe(1))
    deferred[0].resolve({ ok: true, status: 200, json: () => Promise.resolve({ packs: [heldRow], total_count: 1 }) } as Response)
    await waitFor(() => expect(getByText("Base Pack")).toBeTruthy())

    // Rapid filter switch: Opened (fetch #2, ripped) then Sold (fetch #3, sold).
    fireEvent.click(getByText("Opened"))
    await waitFor(() => expect(deferred.length).toBe(2))
    fireEvent.click(getByText("Sold"))
    await waitFor(() => expect(deferred.length).toBe(3))

    const rippedRow = { ...heldRow, pack_nft_id: "111", pack_name: "RIPPED-PACK", status: "ripped" as const }
    const soldRow = { ...heldRow, pack_nft_id: "222", pack_name: "SOLD-PACK", status: "flipped" as const }

    // Resolve the NEWEST (Sold, #3) first, then the STALE (Opened, #2) last.
    deferred[2].resolve({ ok: true, status: 200, json: () => Promise.resolve({ packs: [soldRow], total_count: 1 }) } as Response)
    await waitFor(() => expect(getByText("SOLD-PACK")).toBeTruthy())
    deferred[1].resolve({ ok: true, status: 200, json: () => Promise.resolve({ packs: [rippedRow], total_count: 1 }) } as Response)

    // The stale Opened response must NOT overwrite the current Sold view.
    await waitFor(() => expect(getByText("SOLD-PACK")).toBeTruthy())
    expect(queryByText("RIPPED-PACK")).toBeNull()
  })

  it("shows the filter-specific empty state", async () => {
    ownerKey = "0xowner"
    fetchMock = routeFetch({
      summary: () => res(200, summaryBody),
      history: () => res(200, { packs: [], total_count: 0 }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("No sealed packs held in NBA Top Shot.")).toBeTruthy())
  })

  it("surfaces a pack-history error", async () => {
    ownerKey = "0xowner"
    fetchMock = routeFetch({
      summary: () => res(200, summaryBody),
      history: () => res(500, { error: "history exploded" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("history exploded")).toBeTruthy())
  })
})
