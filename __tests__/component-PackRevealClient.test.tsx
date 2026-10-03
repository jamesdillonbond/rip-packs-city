// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import PackRevealClient, { type RevealCard } from "@/app/giveaways/[slug]/PackRevealClient"

// The pack reveal (2026-10-03). What matters: the pack starts sealed, cards come
// out lowest value first and the chase card LAST, "chase" is only claimed when
// one card really is worth more than the rest, and a finished or skipped reveal
// hands over to the plain pack grid and is remembered for this browser.

const card = (moment_id: string, player_name: string, fmv_usd: number | null): RevealCard => ({
  moment_id,
  player_name,
  set_name: "Base Set",
  tier: "common",
  serial_number: 5,
  fmv_usd,
})

const PACK = [card("30", "Chase Guy", 40), card("10", "Cheap One", 1), card("20", "Middle", 5)]

function renderReveal(moments = PACK) {
  return render(
    <PackRevealClient slug="fall-drop" packNo={3} moments={moments}>
      <div>THE GRID</div>
    </PackRevealClient>,
  )
}

const revealedNames = () => screen.queryAllByTestId("revealed-card").map((el) => el.textContent ?? "")

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("PackRevealClient", () => {
  it("opens card by card, lowest first, and saves the chase card for last", () => {
    renderReveal()
    expect(screen.getByText("Pack #3")).toBeTruthy()
    expect(screen.getByText("3 Moments inside")).toBeTruthy()
    expect(screen.queryByText("THE GRID")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    expect(revealedNames()).toHaveLength(1)
    expect(revealedNames()[0]).toContain("Cheap One")
    expect(screen.queryByText("Pack #3")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Next card (2 of 3)" }))
    expect(revealedNames()[1]).toContain("Middle")
    expect(screen.queryByText("Chase card")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Reveal the last card" }))
    const names = revealedNames()
    expect(names[2]).toContain("Chase Guy")
    expect(names[2]).toContain("Chase card")
    expect(names[2]).toContain("$40.00")

    // Top Shot art by Flow id
    const img = screen.getByAltText("Chase Guy") as HTMLImageElement
    expect(img.src).toBe("https://assets.nbatopshot.com/media/30/image?width=400")

    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText("THE GRID")).toBeTruthy()
    expect(localStorage.getItem("rpc_giveaway_opened:fall-drop:3")).toBe("1")
  })

  it("an already-opened pack shows the grid, not the sealed pack", () => {
    localStorage.setItem("rpc_giveaway_opened:fall-drop:3", "1")
    renderReveal()
    expect(screen.getByText("THE GRID")).toBeTruthy()
    expect(screen.queryByText("Pack #3")).toBeNull()
  })

  it("a pack of equal cards claims no chase card", () => {
    renderReveal([card("1", "A", 2), card("2", "B", 2)])
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    fireEvent.click(screen.getByRole("button", { name: "Reveal the last card" }))
    expect(revealedNames()).toHaveLength(2)
    expect(screen.queryByText("Chase card")).toBeNull()
  })

  it("a one-card pack says Moment, has no chase, and an empty pack falls through to the grid", () => {
    renderReveal([card("1", "Solo", 3)])
    expect(screen.getByText("1 Moment inside")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    expect(screen.queryByText("Chase card")).toBeNull()
    cleanup()
    renderReveal([])
    expect(screen.getByText("THE GRID")).toBeTruthy()
  })

  it("blocked storage never breaks the reveal (it just shows again next visit)", () => {
    const orig = Storage.prototype.getItem
    const origSet = Storage.prototype.setItem
    Storage.prototype.getItem = () => {
      throw new Error("blocked")
    }
    Storage.prototype.setItem = () => {
      throw new Error("blocked")
    }
    try {
      renderReveal()
      expect(screen.getByText("Pack #3")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Show all" }))
      expect(screen.getByText("THE GRID")).toBeTruthy()
    } finally {
      Storage.prototype.getItem = orig
      Storage.prototype.setItem = origSet
    }
  })

  it("a card with no art or name still renders honestly", () => {
    renderReveal([{ moment_id: "not-numeric", player_name: null, set_name: null, tier: null, serial_number: null, fmv_usd: null }])
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    expect(screen.getByText("Unknown player")).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
    expect(revealedNames()[0]).toContain("—")
  })
})
