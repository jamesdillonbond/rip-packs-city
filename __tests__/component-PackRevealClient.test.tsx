// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react"
import PackRevealClient, { CHARGE_MS, TEAR_MS, type RevealCard } from "@/app/giveaways/[slug]/PackRevealClient"

// The pack opening (visuals rebuilt 2026-11-08). What matters: the pack starts sealed,
// tears open, the cards flip lowest value first, the chase card charges before it flips
// and is labelled, the summary states the pack total only when every card is priced,
// "Done" / "Show all" remember the pack for this browser, and reduced motion waits 0 ms.

const CARDS: RevealCard[] = [
  { moment_id: "30", player_name: "Luka Doncic", set_name: "Holo Icon", tier: "LEGENDARY", serial_number: 12, fmv_usd: 400 },
  { moment_id: "10", player_name: "Anfernee Simons", set_name: "Base", tier: "COMMON", serial_number: 900, fmv_usd: 2 },
  { moment_id: "20", player_name: "Damian Lillard", set_name: "Base", tier: "RARE", serial_number: 7, fmv_usd: 20 },
]

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }))
  window.matchMedia = globalThis.matchMedia
}

beforeEach(() => {
  vi.useFakeTimers()
  reduceMotion(false)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const renderPack = (cards = CARDS) =>
  render(
    <PackRevealClient slug="fall-drop" packNo={4} moments={cards} title="Fall Drop">
      <div>delivery grid</div>
    </PackRevealClient>,
  )

describe("PackRevealClient", () => {
  it("tears open, flips lowest first, charges the chase, then summarises and remembers", () => {
    renderPack()
    expect(screen.getByTestId("sealed-pack")).toBeTruthy()
    expect(screen.getByText("3 Moments inside")).toBeTruthy()
    expect(screen.queryByTestId("revealed-card")).toBeNull()
    // the RPC logo is on the pack itself (Trevor, 2026-11-08)
    expect((within(screen.getByTestId("sealed-pack")).getByAltText("Rip Packs City") as HTMLImageElement).getAttribute("src")).toBe(
      "/rip-packs-city-logo-320.png",
    )

    // opening v3 (2026-11-10): the drop name is printed on the pack
    expect(within(screen.getByTestId("sealed-pack")).getByText("Fall Drop")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    // mid-tear: the pack is animating out, no card yet
    expect(screen.getByTestId("sealed-pack").className).toContain("rpc-gw-pack--tear")
    act(() => vi.advanceTimersByTime(TEAR_MS))
    expect(screen.queryByTestId("sealed-pack")).toBeNull()
    expect(screen.getByText("3 left")).toBeTruthy()
    // ...and on every card back in the stack
    expect(screen.getByTestId("card-stack").querySelectorAll('img[src="/rip-packs-city-logo-320.png"]').length).toBe(3)

    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    expect(screen.getByTestId("revealed-card").getAttribute("data-tier")).toBe("common")
    expect(within(screen.getByTestId("revealed-card")).getByText("Anfernee Simons")).toBeTruthy()
    // v3: the stage glow takes the tier of the card just flipped; a common throws no sparks
    const stage = () => screen.getByTestId("pack-reveal").querySelector(".rpc-gw-stage") as HTMLElement
    expect(stage().getAttribute("data-tier")).toBe("common")
    expect(screen.getByTestId("revealed-card").querySelector(".rpc-gw-sparks")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /next card \(2 of 3\)/i }))
    expect(within(screen.getByTestId("revealed-card")).getByText("Damian Lillard")).toBeTruthy()
    expect(stage().getAttribute("data-tier")).toBe("rare")
    expect(screen.getByTestId("revealed-card").querySelectorAll(".rpc-gw-sparks > i").length).toBe(10)
    expect(stage().className).not.toContain("is-slam")

    // the chase: the stack charges first, nothing is revealed until the charge ends
    const last = screen.getAllByRole("button", { name: "Reveal the last card" })
    fireEvent.click(last[last.length - 1])
    expect(screen.getByTestId("card-stack").className).toContain("rpc-gw-stack--charge")
    // the charge glows in the colour of the card about to land
    expect(screen.getByTestId("card-stack").getAttribute("data-tier")).toBe("legendary")
    expect(stage().className).toContain("is-charging")
    expect(screen.queryByText("Luka Doncic")).toBeNull()
    act(() => vi.advanceTimersByTime(CHARGE_MS))
    // the chase stays centre stage, face up, before the summary
    expect(screen.getByTestId("revealed-card").className).toContain("is-chase")
    // the chase lands with a flash, a stage shake and the big spark burst
    expect(stage().className).toContain("is-slam")
    expect(stage().querySelector(".rpc-gw-flash")).toBeTruthy()
    expect(screen.getByTestId("revealed-card").querySelectorAll(".rpc-gw-sparks > i").length).toBe(26)
    expect(within(screen.getByTestId("revealed-card")).getByText("Chase card")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))

    // summary: every card, the chase labelled, the total stated
    const summary = screen.getByTestId("pack-summary")
    expect(within(summary).getByText("Luka Doncic")).toBeTruthy()
    // the screen-reader line announces the chase
    expect(screen.getByText("Luka Doncic, the chase card")).toBeTruthy()
    expect(within(summary).getByText("Chase card")).toBeTruthy()
    expect(screen.getByText(/Total FMV \$422/)).toBeTruthy()
    expect(localStorage.getItem("rpc_giveaway_opened:fall-drop:4")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.getByText("delivery grid")).toBeTruthy()
    expect(localStorage.getItem("rpc_giveaway_opened:fall-drop:4")).toBe("1")
  })

  it("never states a pack total with an unpriced card in it, and a pack of equals has no chase", () => {
    renderPack([
      { moment_id: "1", player_name: "A", set_name: "S", tier: "COMMON", serial_number: 1, fmv_usd: 2 },
      { moment_id: "2", player_name: "B", set_name: "S", tier: null, serial_number: 2, fmv_usd: null },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    act(() => vi.advanceTimersByTime(TEAR_MS))
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    const last = screen.getAllByRole("button", { name: "Reveal the last card" })
    fireEvent.click(last[last.length - 1])
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))
    expect(screen.getByTestId("pack-summary")).toBeTruthy()
    expect(screen.queryByText(/Total FMV/)).toBeNull()
    expect(screen.queryByText("Chase card")).toBeNull()
  })

  it("reduced motion: the tear and the chase charge wait 0 ms", () => {
    reduceMotion(true)
    renderPack()
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    act(() => vi.advanceTimersByTime(0))
    expect(screen.queryByTestId("sealed-pack")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    fireEvent.click(screen.getByRole("button", { name: /next card/i }))
    const last = screen.getAllByRole("button", { name: "Reveal the last card" })
    fireEvent.click(last[last.length - 1])
    act(() => vi.advanceTimersByTime(0))
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))
    expect(screen.getByTestId("pack-summary")).toBeTruthy()
  })

  it("Show all skips the opening at any point and remembers it; an opened pack shows the grid straight away", () => {
    renderPack()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getByText("delivery grid")).toBeTruthy()
    cleanup()
    renderPack()
    expect(screen.getByText("delivery grid")).toBeTruthy()
    expect(screen.queryByTestId("pack-reveal")).toBeNull()
  })
})

// Carried over from the 2026-10-03 suite (properties that still hold after the rebuild).
describe("PackRevealClient — carried-over properties", () => {
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    act(() => vi.advanceTimersByTime(TEAR_MS))
  }

  it("an already-opened pack shows the grid, not the sealed pack", () => {
    localStorage.setItem("rpc_giveaway_opened:fall-drop:4", "1")
    renderPack()
    expect(screen.getByText("delivery grid")).toBeTruthy()
    expect(screen.queryByText("Pack #4")).toBeNull()
  })

  it("a one-card pack says Moment and has no chase; an empty pack falls through to the grid", () => {
    renderPack([{ moment_id: "1", player_name: "Solo", set_name: "S", tier: "COMMON", serial_number: 1, fmv_usd: 3 }])
    expect(screen.getByText("1 Moment inside")).toBeTruthy()
    open()
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))
    expect(screen.getByTestId("pack-summary")).toBeTruthy()
    expect(screen.queryByText("Chase card")).toBeNull()
    cleanup()
    renderPack([])
    expect(screen.getByText("delivery grid")).toBeTruthy()
  })

  it("Top Shot art comes by Flow id", () => {
    renderPack()
    open()
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    const img = screen.getByAltText("Anfernee Simons") as HTMLImageElement
    expect(img.src).toBe("https://assets.nbatopshot.com/media/10/image?width=480")
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
      renderPack()
      expect(screen.getByText("Pack #4")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Show all" }))
      expect(screen.getByText("delivery grid")).toBeTruthy()
    } finally {
      Storage.prototype.getItem = orig
      Storage.prototype.setItem = origSet
    }
  })

  it("a card with no art or name still renders honestly (never \"Unknown\")", () => {
    renderPack([{ moment_id: "not-numeric", player_name: null, set_name: null, tier: null, serial_number: null, fmv_usd: null }])
    open()
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))
    expect(screen.queryByText(/Unknown/i)).toBeNull()
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.getByTestId("pack-summary").textContent).toContain("—")
  })
})

describe("PackRevealClient — preview mode and the chase buzz (2026-11-08)", () => {
  const playThrough = () => {
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    act(() => vi.advanceTimersByTime(TEAR_MS))
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    fireEvent.click(screen.getByRole("button", { name: /next card/i }))
    const last = screen.getAllByRole("button", { name: "Reveal the last card" })
    fireEvent.click(last[last.length - 1])
    act(() => vi.advanceTimersByTime(CHARGE_MS))
  }

  it("a preview never reads or writes the claimer's opened flag, and Done calls onDone", () => {
    localStorage.setItem("rpc_giveaway_opened:fall-drop:4", "1") // even an opened pack previews from sealed
    const onDone = vi.fn()
    render(
      <PackRevealClient slug="fall-drop" packNo={4} moments={CARDS} preview onDone={onDone}>
        <div>delivery grid</div>
      </PackRevealClient>,
    )
    expect(screen.getByTestId("sealed-pack")).toBeTruthy()
    localStorage.clear()
    playThrough()
    fireEvent.click(screen.getByRole("button", { name: "See the whole pack" }))
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("rpc_giveaway_opened:fall-drop:4")).toBeNull()
    expect(screen.queryByText("delivery grid")).toBeNull()
  })

  it("the chase landing buzzes the phone once; ordinary cards do not", () => {
    const vibrate = vi.fn(() => true)
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true })
    renderPack()
    fireEvent.click(screen.getByRole("button", { name: "Open pack" }))
    act(() => vi.advanceTimersByTime(TEAR_MS))
    fireEvent.click(screen.getByRole("button", { name: "Flip the first card" }))
    expect(vibrate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /next card/i }))
    const last = screen.getAllByRole("button", { name: "Reveal the last card" })
    fireEvent.click(last[last.length - 1])
    act(() => vi.advanceTimersByTime(CHARGE_MS))
    expect(vibrate).toHaveBeenCalledTimes(1)
  })

  it("no buzz under reduced motion, and a vibrate that throws breaks nothing", () => {
    const vibrate = vi.fn(() => {
      throw new Error("not allowed")
    })
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true })
    reduceMotion(true)
    renderPack()
    playThrough()
    expect(vibrate).not.toHaveBeenCalled()
    cleanup()
    reduceMotion(false)
    renderPack()
    playThrough()
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "See the whole pack" })).toBeTruthy()
  })
})

// Opening v3 (2026-11-10): the pack and the flipped card tilt toward the pointer.
describe("PackRevealClient — pointer tilt", () => {
  const box = { left: 0, top: 0, width: 200, height: 300, right: 200, bottom: 300, x: 0, y: 0, toJSON() {} }

  it("tilts the sealed pack toward the pointer and settles when it leaves", () => {
    renderPack()
    const pack = screen.getByTestId("sealed-pack")
    pack.getBoundingClientRect = () => box as DOMRect
    fireEvent.pointerMove(pack, { clientX: 200, clientY: 0 })
    expect(pack.style.getPropertyValue("--gw-ry")).toBe("11.0deg")
    expect(pack.style.getPropertyValue("--gw-rx")).toBe("9.0deg")
    expect(pack.style.getPropertyValue("--gw-mx")).toBe("100%")
    fireEvent.pointerLeave(pack)
    expect(pack.style.getPropertyValue("--gw-ry")).toBe("")
  })

  it("does not tilt under reduced motion", () => {
    reduceMotion(true)
    renderPack()
    const pack = screen.getByTestId("sealed-pack")
    pack.getBoundingClientRect = () => box as DOMRect
    fireEvent.pointerMove(pack, { clientX: 200, clientY: 0 })
    expect(pack.style.getPropertyValue("--gw-ry")).toBe("")
  })
})
