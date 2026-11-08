// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import PackWall, { DRAW_MS } from "@/app/giveaways/[slug]/PackWall"

// The packs still on the table (2026-11-08). What matters: the count is the drop's own
// (never a guess), claimed packs read as claimed, the shuffle lands on the pack the
// DATABASE drew and says it was drawn from the packs that were left, and reduced
// motion lands at once.

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }))
  window.matchMedia = globalThis.matchMedia
}

const states = () => screen.getByTestId("pack-wall").querySelectorAll(".rpc-gw-wall-pack")

beforeEach(() => {
  vi.useFakeTimers()
  reduceMotion(false)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("PackWall", () => {
  it("shows every pack, the claimed ones dimmed, and how many are left", () => {
    render(<PackWall total={5} claimed={2} />)
    const all = [...states()].map((el) => el.getAttribute("data-state"))
    expect(all).toEqual(["open", "open", "open", "claimed", "claimed"])
    expect(screen.getByText("3 of 5 packs left")).toBeTruthy()
    // each pack carries the RPC logo
    expect(screen.getByTestId("pack-wall").querySelectorAll('img[src="/rip-packs-city-logo-320.png"]').length).toBe(5)
  })

  it("shuffles, then lands on one bright pack labelled with the drawn number and calls onLanded once", () => {
    const onLanded = vi.fn()
    render(<PackWall total={5} claimed={2} drawn={4} onLanded={onLanded} />)
    expect(screen.getByText("Drawing your pack…")).toBeTruthy()
    act(() => vi.advanceTimersByTime(DRAW_MS / 2))
    expect(onLanded).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(DRAW_MS))
    expect(onLanded).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Pack #4 is yours — drawn at random from the 3 that were left.")).toBeTruthy()
    const landed = [...states()].filter((el) => el.getAttribute("data-state") === "landed")
    expect(landed).toHaveLength(1)
    expect(landed[0].classList.contains("is-claimed")).toBe(false)
  })

  it("reduced motion lands at once", () => {
    reduceMotion(true)
    const onLanded = vi.fn()
    render(<PackWall total={3} claimed={0} drawn={1} onLanded={onLanded} />)
    expect(onLanded).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Pack #1 is yours/)).toBeTruthy()
  })

  it("a very large drop draws at most 60 packs and says so; one pack reads singular; no packs renders nothing", () => {
    render(<PackWall total={100} claimed={10} />)
    expect(states()).toHaveLength(60)
    expect(screen.getByText("90 of 100 packs left (showing 60)")).toBeTruthy()
    cleanup()
    render(<PackWall total={1} claimed={0} />)
    expect(screen.getByText("1 of 1 pack left")).toBeTruthy()
    cleanup()
    const { container } = render(<PackWall total={0} claimed={0} />)
    expect(container.innerHTML).toBe("")
  })
})
