// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import ExplainButton from "@/components/ExplainButton"

// ExplainButton opens the concierge with a pre-filled question by dispatching
// `rpc-concierge-ask` (SupportChat listens for it). It sits INSIDE clickable rows and
// cards, so it must not let its click reach the row (that would navigate away from
// the question the user just asked). Added 2026-10-11.

afterEach(cleanup)

describe("ExplainButton", () => {
  it("asks the concierge the question WITH its context", () => {
    const seen: string[] = []
    const onAsk = (e: Event) => seen.push((e as CustomEvent<{ text: string }>).detail.text)
    window.addEventListener("rpc-concierge-ask", onAsk)
    try {
      const { getByRole } = render(
        <ExplainButton question="How is this FMV calculated?" context="Top Shot edition 26:1234 FMV $4.20" />,
      )
      fireEvent.click(getByRole("button", { name: "Explain: How is this FMV calculated?" }))
      expect(seen).toEqual(["How is this FMV calculated?\n\nContext: Top Shot edition 26:1234 FMV $4.20"])
    } finally {
      window.removeEventListener("rpc-concierge-ask", onAsk)
    }
  })

  it("does not let the click reach the row or card it sits in", () => {
    const rowClick = vi.fn()
    const { getByRole } = render(
      <div onClick={rowClick}>
        <ExplainButton question="Why LOW?" context="ctx" />
      </div>,
    )
    fireEvent.click(getByRole("button"))
    expect(rowClick).not.toHaveBeenCalled()
  })

  it("brightens on hover and dims on leave (a hint, never hidden)", () => {
    const { getByRole } = render(<ExplainButton question="q" context="c" size={20} />)
    const b = getByRole("button") as HTMLButtonElement
    expect(b.style.opacity).toBe("0.4")
    fireEvent.mouseEnter(b)
    expect(b.style.opacity).toBe("0.85")
    fireEvent.mouseLeave(b)
    expect(b.style.opacity).toBe("0.4")
    expect(b.style.width).toBe("20px")
  })
})
