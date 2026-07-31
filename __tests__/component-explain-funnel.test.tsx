// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// ExplainButton (opens the concierge with a pre-filled question via a
// `rpc-concierge-ask` CustomEvent) and FunnelTracker (fires a top-of-funnel
// beacon on mount, deduped, with perPath re-fire on navigation).

let pathname = "/insights/top-sales"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))

const trackFunnelEvent = vi.hoisted(() => vi.fn())
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent }))

import ExplainButton from "@/components/ExplainButton"
import FunnelTracker from "@/components/FunnelTracker"

beforeEach(() => {
  pathname = "/insights/top-sales"
  trackFunnelEvent.mockClear()
})
afterEach(() => {
  cleanup()
})

describe("ExplainButton", () => {
  it("dispatches rpc-concierge-ask with the question + context on click", () => {
    const spy = vi.fn()
    window.addEventListener("rpc-concierge-ask", spy as EventListener)
    const { getByRole } = render(
      <ExplainButton question="How is this FMV calculated?" context="LeBron 2020 edition" />,
    )
    fireEvent.click(getByRole("button"))
    window.removeEventListener("rpc-concierge-ask", spy as EventListener)

    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0][0] as CustomEvent
    expect(ev.detail.text).toBe("How is this FMV calculated?\n\nContext: LeBron 2020 edition")
  })

  it("exposes an accessible label with the question", () => {
    const { getByLabelText } = render(<ExplainButton question="Why?" context="ctx" />)
    expect(getByLabelText("Explain: Why?")).toBeTruthy()
  })
})

describe("FunnelTracker", () => {
  it("fires the beacon once on mount, defaulting surface to the pathname", () => {
    render(<FunnelTracker eventType="insights_view" />)
    expect(trackFunnelEvent).toHaveBeenCalledTimes(1)
    expect(trackFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "insights_view", surface: "/insights/top-sales", walletAddress: null }),
    )
  })

  it("passes an explicit surface + wallet when provided", () => {
    render(<FunnelTracker eventType="share_view" surface="share" walletAddress="0xabc" />)
    expect(trackFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "share_view", surface: "share", walletAddress: "0xabc" }),
    )
  })

  it("does not re-fire on a re-render at the same path (dedup)", () => {
    const { rerender } = render(<FunnelTracker eventType="insights_view" />)
    rerender(<FunnelTracker eventType="insights_view" />)
    expect(trackFunnelEvent).toHaveBeenCalledTimes(1)
  })
})
