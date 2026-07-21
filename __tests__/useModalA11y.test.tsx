// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import { useModalA11y } from "@/lib/hooks/useModalA11y"

// Harness: a minimal modal that mounts the hook, so we exercise the shared
// a11y primitive that MomentDetailModal / TrophyPickerModal
// all rely on. `rAF` is stubbed to run synchronously so focusFirst is
// observable without a real animation frame.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Modal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const ref = useModalA11y<HTMLDivElement>(isOpen, onClose)
  if (!isOpen) return <button data-testid="opener">opener</button>
  return (
    <div role="dialog" aria-modal="true">
      <div ref={ref}>
        <button data-testid="first">first</button>
        <button data-testid="mid">mid</button>
        <button data-testid="last">last</button>
      </div>
    </div>
  )
}

function withSyncRaf() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
}

describe("useModalA11y", () => {
  it("moves focus to the first focusable when opened", () => {
    withSyncRaf()
    const { getByTestId } = render(<Modal isOpen onClose={() => {}} />)
    expect(document.activeElement).toBe(getByTestId("first"))
  })

  it("closes on Escape", () => {
    withSyncRaf()
    const onClose = vi.fn()
    render(<Modal isOpen onClose={onClose} />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("traps Tab: from the last element, forward Tab wraps to the first", () => {
    withSyncRaf()
    const { getByTestId } = render(<Modal isOpen onClose={() => {}} />)
    getByTestId("last").focus()
    fireEvent.keyDown(window, { key: "Tab" })
    expect(document.activeElement).toBe(getByTestId("first"))
  })

  it("traps Shift+Tab: from the first element, backward wraps to the last", () => {
    withSyncRaf()
    const { getByTestId } = render(<Modal isOpen onClose={() => {}} />)
    getByTestId("first").focus()
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(getByTestId("last"))
  })

  it("does not intercept Tab in the middle of the focus order", () => {
    withSyncRaf()
    const { getByTestId } = render(<Modal isOpen onClose={() => {}} />)
    getByTestId("mid").focus()
    const evt = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true })
    window.dispatchEvent(evt)
    // Not at an edge → the trap must not preventDefault (browser handles it).
    expect(evt.defaultPrevented).toBe(false)
  })

  it("restores focus to the previously-focused element on close", () => {
    withSyncRaf()
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { rerender } = render(<Modal isOpen onClose={() => {}} />)
    // Closing (isOpen -> false) runs the effect cleanup, restoring focus.
    act(() => {
      rerender(<Modal isOpen={false} onClose={() => {}} />)
    })
    expect(document.activeElement).toBe(opener)
    document.body.removeChild(opener)
  })

  it("does nothing (no listeners, no focus move) while closed", () => {
    withSyncRaf()
    const onClose = vi.fn()
    render(<Modal isOpen={false} onClose={onClose} />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
  })
})
