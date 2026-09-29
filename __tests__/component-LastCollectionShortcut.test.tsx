// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, act } from "@testing-library/react"
import LastCollectionShortcut from "@/components/hub/LastCollectionShortcut"

// The /sniper hub's "Back to <X> Sniper" shortcut. ⛔ It must appear ONLY for a
// collection the visitor actually visited — getLastCollection() substitutes Top
// Shot for a first-timer, and "Back to Top Shot" to someone who never went there
// is a false claim. And never for a collection with no sniper page.

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("LastCollectionShortcut", () => {
  it("renders nothing for a first-time visitor (no recorded collection)", () => {
    const { queryByTestId } = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(queryByTestId("last-collection-shortcut")).toBeNull()
  })

  it("links back to the recorded collection's sniper", () => {
    localStorage.setItem("rpc_last_collection", "nfl-all-day")
    const { getByTestId } = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(getByTestId("last-collection-shortcut").getAttribute("href")).toBe("/nfl-all-day/sniper")
  })

  it("renders nothing when the recorded collection has no sniper page", () => {
    localStorage.setItem("rpc_last_collection", "ufc")
    const { queryByTestId } = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(queryByTestId("last-collection-shortcut")).toBeNull()
  })

  it("scopes to the page it is given — a market shortcut for a collection with a market", () => {
    localStorage.setItem("rpc_last_collection", "candy-mlb")
    // Candy has a market and no sniper: the market shortcut shows, the sniper one does not.
    const m = render(<LastCollectionShortcut page="market" label="Market" />)
    expect(m.getByTestId("last-collection-shortcut").getAttribute("href")).toBe("/candy-mlb/market")
    expect(m.getByTestId("last-collection-shortcut").textContent).toContain("Back to")
    cleanup()
    const s = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(s.queryByTestId("last-collection-shortcut")).toBeNull()
  })

  it("follows a change made in another tab (storage event), and unsubscribes on unmount", () => {
    const { queryByTestId, unmount } = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(queryByTestId("last-collection-shortcut")).toBeNull()
    localStorage.setItem("rpc_last_collection", "nba-top-shot")
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "rpc_last_collection" })) })
    expect(queryByTestId("last-collection-shortcut")?.getAttribute("href")).toBe("/nba-top-shot/sniper")
    unmount()
  })

  it("renders nothing for an unknown recorded id", () => {
    localStorage.setItem("rpc_last_collection", "not-a-collection")
    const { queryByTestId } = render(<LastCollectionShortcut page="sniper" label="Sniper" />)
    expect(queryByTestId("last-collection-shortcut")).toBeNull()
  })
})
