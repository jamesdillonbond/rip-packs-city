// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import WhaleWatch7d from "@/components/WhaleWatch7d"

// Drives the Whale Watch · 7d leaderboard end-to-end: fetch /api/market/whale-watch,
// loading → err/empty/table, the fmtCurrency banding (— / $rounded / 2dp), the
// truncAddr-vs-@username label, and the collection filter that BOTH re-fetches
// (adds ?slug=) and hides the Collection column. The money + address formatting is
// the regression surface — a broken fmt renders "$NaN" on a public market board.

vi.mock("@/lib/analytics/username-resolver", () => ({
  // resolve one address to a handle, leave the other bare
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

const whales = [
  {
    buyer_address: "0xaaaaaaaaaaaaaaaa",
    collection: "nba_top_shot",
    purchases_7d: 12,
    volume_7d_usd: 1500, // >= 1000 → "$1,500"
    avg_purchase_usd: 12.5, // < 1000 → "$12.50"
    distinct_editions: 3,
  },
  {
    buyer_address: "0xbbbbbbbbbbbbbbbb",
    collection: "ufc_strike",
    purchases_7d: 4,
    volume_7d_usd: null, // → "—"
    avg_purchase_usd: 5,
    distinct_editions: 1,
  },
]

describe("WhaleWatch7d", () => {
  it("renders the ranked table with money banding + username/truncated labels", async () => {
    fetchMock.mockReturnValueOnce(okJson({ whales }))
    const { getByText, queryByText } = render(<WhaleWatch7d />)
    await waitFor(() => expect(getByText("$1,500")).toBeTruthy())
    expect(getByText("$12.50")).toBeTruthy() // 2-dp for < $1000
    expect(getByText("—")).toBeTruthy() // null volume
    expect(getByText("@whale")).toBeTruthy() // resolved username
    expect(getByText("0xbbbb…bbbb")).toBeTruthy() // truncated (unresolved)
    // default (no slug) shows the Collection column with a friendly label
    expect(getByText("Top Shot")).toBeTruthy()
    expect(queryByText("Loading…")).toBeNull()
  })

  it("shows the empty state when the API returns no whales", async () => {
    fetchMock.mockReturnValueOnce(okJson({ whales: [] }))
    const { getByText } = render(<WhaleWatch7d />)
    await waitFor(() => expect(getByText("No top buyers in the last 7d.")).toBeTruthy())
  })

  it("surfaces an API error string and renders no rows", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) } as Response),
    )
    const { getByText } = render(<WhaleWatch7d />)
    await waitFor(() => expect(getByText("boom")).toBeTruthy())
    expect(getByText("No top buyers in the last 7d.")).toBeTruthy()
  })

  it("collection filter re-fetches with ?slug= and hides the Collection column", async () => {
    fetchMock.mockReturnValue(okJson({ whales: [whales[0]] }))
    const { getByLabelText, queryByText } = render(<WhaleWatch7d />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).not.toContain("slug=")

    fireEvent.change(getByLabelText("Collection filter"), { target: { value: "nba_top_shot" } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain("slug=nba_top_shot")
    // with a slug selected, the per-row Collection label column is gone
    await waitFor(() => expect(queryByText("Top Shot")).toBeNull())
  })
})
