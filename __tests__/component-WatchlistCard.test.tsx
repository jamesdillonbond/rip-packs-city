// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import WatchlistCard from "@/components/profile/WatchlistCard"

// Drives the profile Watchlist card's list + remove path: fetch
// /api/profile/watchlist, loading → empty/list, the count badge, the null-safe
// player/ask/fmv/target cells, the "Below Target" chip, and the optimistic
// Remove (DELETE then drop the row locally). The add-modal is out of scope here.

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

const items = [
  {
    id: "w1",
    edition_id: "e1",
    player_name: "Ja Morant",
    set_name: "Base",
    tier: "RARE",
    target_price: 50,
    current_fmv: 120,
    current_ask: 65,
    below_target: false,
    notes: null,
    created_at: "2026-04-01",
  },
  {
    id: "w2",
    edition_id: "e2",
    player_name: null, // → "Unknown"
    set_name: null,
    tier: null,
    target_price: null, // → "—"
    current_fmv: null, // → "—"
    current_ask: null, // → "—"
    below_target: true, // → "Below Target" chip
    notes: null,
    created_at: "2026-04-02",
  },
]

describe("WatchlistCard", () => {
  it("renders the list with the count badge and null-safe cells", async () => {
    fetchMock.mockReturnValueOnce(okJson({ items }))
    const { getByText } = render(<WatchlistCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("Ja Morant")).toBeTruthy())
    expect(getByText("Unknown")).toBeTruthy() // null player fallback
    expect(getByText("Below Target")).toBeTruthy() // only the below_target row
    expect(getByText("2")).toBeTruthy() // count badge
    // the null row's ask/fmv/target all render "—" (never a blank or NaN).
    // getByText matches an element's FULL text, so Ask/FMV read "Ask —"/"FMV —"
    // and only the target cell is a bare "—".
    expect(getByText("Ask —")).toBeTruthy()
    expect(getByText("FMV —")).toBeTruthy()
    expect(getByText("—")).toBeTruthy()
    // fetch scoped to the owner key
    expect(fetchMock.mock.calls[0][0]).toContain("ownerKey=0xowner")
  })

  it("shows the empty state when nothing is watched", async () => {
    fetchMock.mockReturnValueOnce(okJson({ items: [] }))
    const { getByText } = render(<WatchlistCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText(/Nothing watched yet/)).toBeTruthy())
  })

  it("Remove issues a DELETE and optimistically drops the row", async () => {
    fetchMock.mockReturnValueOnce(okJson({ items }))
    fetchMock.mockReturnValueOnce(okJson({ ok: true })) // the DELETE
    const { getByText, queryByText, getAllByText } = render(<WatchlistCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("Ja Morant")).toBeTruthy())

    fireEvent.click(getAllByText("Remove")[0]) // remove Ja Morant (w1)
    await waitFor(() => expect(queryByText("Ja Morant")).toBeNull())

    // the second fetch was a DELETE carrying the item id + owner key
    const del = fetchMock.mock.calls[1]
    expect(del[1].method).toBe("DELETE")
    const body = JSON.parse(del[1].body)
    expect(body).toEqual({ ownerKey: "0xowner", itemId: "w1" })
  })

  it("does not fetch when ownerKey is empty (guarded load)", () => {
    render(<WatchlistCard ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
