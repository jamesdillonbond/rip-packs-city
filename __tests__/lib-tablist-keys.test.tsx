// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, fireEvent, cleanup } from "@testing-library/react"
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

function Buttons({ onPick }: { onPick: (k: string) => void }) {
  return (
    <div role="tablist" onKeyDown={onTablistKeyDown}>
      {["a", "b", "c"].map((k) => (
        <button key={k} type="button" role="tab" aria-selected={k === "a"} onClick={() => onPick(k)}>{k}</button>
      ))}
      <button type="button" role="tab" aria-disabled="true">off</button>
    </div>
  )
}
function Links() {
  return (
    <div role="tablist" style={{ display: "contents" }} onKeyDown={onTablistKeyDown}>
      <a role="tab" href="https://example.com/x" aria-selected>x</a>
      <a role="tab" href="https://example.com/y">y</a>
    </div>
  )
}

describe("onTablistKeyDown — the APG tabs keyboard contract", () => {
  // No globals in this vitest config, so RTL does not auto-clean between tests.
  afterEach(cleanup)
  it("ArrowRight moves focus to the next BUTTON tab and activates it; wraps; skips a disabled tab", () => {
    const onPick = vi.fn()
    const { getAllByRole } = render(<Buttons onPick={onPick} />)
    const tabs = getAllByRole("tab")
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" })
    expect(document.activeElement).toBe(tabs[1])
    expect(onPick).toHaveBeenLastCalledWith("b")
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" }) // wraps past the disabled one
    expect(document.activeElement).toBe(tabs[0])
    expect(onPick).toHaveBeenLastCalledWith("a")
  })
  it("Home/End jump; ArrowLeft wraps backwards", () => {
    const { getAllByRole } = render(<Buttons onPick={() => {}} />)
    const tabs = getAllByRole("tab")
    tabs[1].focus()
    fireEvent.keyDown(tabs[1], { key: "End" })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2], { key: "Home" })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" })
    expect(document.activeElement).toBe(tabs[2])
  })
  it("a LINK tab only takes focus on arrow — arrows never navigate (manual activation)", () => {
    const { getAllByRole } = render(<Links />)
    const tabs = getAllByRole("tab")
    const click = vi.fn()
    tabs[1].addEventListener("click", click)
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" })
    expect(document.activeElement).toBe(tabs[1])
    expect(click).not.toHaveBeenCalled()
  })
  it("ignores other keys and a keydown from outside the tabs", () => {
    const onPick = vi.fn()
    const { getAllByRole, container } = render(<Buttons onPick={onPick} />)
    const tabs = getAllByRole("tab")
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: "Enter" })
    expect(document.activeElement).toBe(tabs[0])
    expect(onPick).not.toHaveBeenCalled()
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: "ArrowRight" })
    expect(onPick).not.toHaveBeenCalled()
  })
})
