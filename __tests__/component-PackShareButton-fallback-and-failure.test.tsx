// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import PackShareButton from "@/components/packs/PackShareButton"

// The paths component-PackShareButton.test.tsx does not reach (2026-10-11):
//  - no Clipboard API (an unsecured context): the textarea + execCommand fallback must
//    copy THIS url and leave nothing behind in the DOM;
//  - the "Copied" confirmation must revert, or the label lies on the next visit;
//  - a failed copy must NOT claim "Copied" — the false-success shape, one button wide.

const URL_ = "https://www.rippackscity.com/nba-top-shot/pack/dist/2935"

function withoutClipboard() {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("PackShareButton — fallback copy, revert, and failure", () => {
  it("copies through a temporary textarea when navigator.clipboard is absent, and removes it", async () => {
    withoutClipboard()
    let copiedValue: string | null = null
    const exec = vi.fn((cmd: string) => {
      // what is selected at copy time is the textarea's value
      const ta = document.querySelector("textarea")
      copiedValue = ta ? (ta as HTMLTextAreaElement).value : null
      return cmd === "copy"
    })
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true })
    const { getByRole } = render(<PackShareButton url={URL_} />)
    fireEvent.click(getByRole("button"))
    await waitFor(() => expect(getByRole("button").textContent).toBe("Copied"))
    expect(exec).toHaveBeenCalledWith("copy")
    expect(copiedValue).toBe(URL_)
    expect(document.querySelector("textarea"), "the fallback textarea was left in the DOM").toBeNull()
  })

  it("reverts 'Copied' to 'Copy link' after the confirmation window", async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const { getByRole } = render(<PackShareButton url={URL_} />)
    await act(async () => {
      fireEvent.click(getByRole("button"))
      await Promise.resolve()
    })
    expect(getByRole("button").textContent).toBe("Copied")
    await act(async () => {
      vi.advanceTimersByTime(1700)
    })
    expect(getByRole("button").textContent).toBe("Copy link")
  })

  it("🚨 a copy that FAILS never says 'Copied'", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const { getByRole } = render(<PackShareButton url={URL_} />)
    await act(async () => {
      fireEvent.click(getByRole("button"))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(URL_)
    expect(getByRole("button").textContent).toBe("Copy link")
  })
})
