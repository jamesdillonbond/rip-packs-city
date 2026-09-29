// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import LastSniperShortcut from "@/components/sniper/LastSniperShortcut"

// The /sniper hub's "Back to <X> Sniper" shortcut. ⛔ It must appear ONLY for a
// collection the visitor actually visited — getLastCollection() substitutes Top
// Shot for a first-timer, and "Back to Top Shot" to someone who never went there
// is a false claim. And never for a collection with no sniper page.

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("LastSniperShortcut", () => {
  it("renders nothing for a first-time visitor (no recorded collection)", () => {
    const { queryByTestId } = render(<LastSniperShortcut />)
    expect(queryByTestId("last-sniper-shortcut")).toBeNull()
  })

  it("links back to the recorded collection's sniper", () => {
    localStorage.setItem("rpc_last_collection", "nfl-all-day")
    const { getByTestId } = render(<LastSniperShortcut />)
    expect(getByTestId("last-sniper-shortcut").getAttribute("href")).toBe("/nfl-all-day/sniper")
  })

  it("renders nothing when the recorded collection has no sniper page", () => {
    localStorage.setItem("rpc_last_collection", "ufc")
    const { queryByTestId } = render(<LastSniperShortcut />)
    expect(queryByTestId("last-sniper-shortcut")).toBeNull()
  })

  it("renders nothing for an unknown recorded id", () => {
    localStorage.setItem("rpc_last_collection", "not-a-collection")
    const { queryByTestId } = render(<LastSniperShortcut />)
    expect(queryByTestId("last-sniper-shortcut")).toBeNull()
  })
})
