// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The banner that makes an /insights board admit a backing-query failure instead of
// rendering the failure as an empty section at HTTP 200 (see lib/insights/board-status.ts).
// The single most important behaviour is the NULL case: a healthy board must render
// nothing at all, so this change is invisible when everything works.

import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { summarizeDegraded, boardStatus } from "@/lib/insights/board-status"

afterEach(cleanup)

describe("DegradedDataNotice", () => {
  it("renders nothing when the summary is null (healthy board is unchanged)", () => {
    const { container } = render(<DegradedDataNotice summary={null} />)
    expect(container.innerHTML).toBe("")
  })

  it("renders nothing for a board set where every section loaded", () => {
    const summary = summarizeDegraded([boardStatus("Market", true), boardStatus("Deals", true)])
    const { container } = render(<DegradedDataNotice summary={summary} />)
    expect(container.innerHTML).toBe("")
  })

  it("names the failed sections and says the blank is a failure, not an empty result", () => {
    const summary = summarizeDegraded([
      boardStatus("Market", true),
      boardStatus("Scarcity", false),
      boardStatus("Players", false),
    ])
    const { container } = render(<DegradedDataNotice summary={summary} />)
    const text = container.textContent ?? ""

    expect(text).toContain("Partial data")
    expect(text).toContain("Scarcity, Players")
    expect(text).toContain("2 of 3 sections could not be loaded")
    // The honesty clause — without it an empty section still reads as a measurement.
    expect(text).toContain("not an empty result")
  })

  it("is announced to assistive tech as a live status", () => {
    const summary = summarizeDegraded([boardStatus("Market", false)])
    const { container } = render(<DegradedDataNotice summary={summary} />)
    const el = container.querySelector('[role="status"]')
    expect(el).not.toBeNull()
    expect(el!.getAttribute("aria-live")).toBe("polite")
  })

  it("surfaces a truncated (partially loaded) board distinctly from an absent one", () => {
    const summary = summarizeDegraded([{ label: "Squeeze board", ok: false, partial: true }])
    const { container } = render(<DegradedDataNotice summary={summary} />)
    expect(container.textContent).toContain("showing an incomplete slice (Squeeze board)")
  })
})
