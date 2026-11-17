// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// Capture the click beacon via a hoisted mock of lib/track-click.
const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock("@/lib/track-click", () => ({ trackOutboundClick: trackMock }))

import TrackedOutboundLink from "@/components/TrackedOutboundLink"

// TrackedOutboundLink renders a new-tab anchor that fires trackOutboundClick
// on click. It defaults the beacon's buyUrl to the anchor href when the
// payload omits one, but preserves an explicit payload buyUrl.

afterEach(() => {
  cleanup()
  trackMock.mockReset()
})

describe("TrackedOutboundLink", () => {
  it("renders a safe new-tab anchor with the href and children", () => {
    const { container } = render(
      <TrackedOutboundLink href="https://flowty.io/x" payload={{ surface: "moment" } as any}>
        View Listing
      </TrackedOutboundLink>
    )
    const a = container.querySelector("a")!
    expect(a.getAttribute("href")).toBe("https://flowty.io/x")
    expect(a.getAttribute("target")).toBe("_blank")
    expect(a.getAttribute("rel")).toBe("noopener noreferrer")
    expect(a.textContent).toBe("View Listing")
  })

  it("fires the beacon defaulting buyUrl to the href when payload omits it", () => {
    const { container } = render(
      <TrackedOutboundLink href="https://flowty.io/x" payload={{ surface: "moment" } as any}>
        go
      </TrackedOutboundLink>
    )
    fireEvent.click(container.querySelector("a")!)
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ surface: "moment", buyUrl: "https://flowty.io/x" }))
  })

  it("preserves an explicit payload buyUrl over the href", () => {
    const { container } = render(
      <TrackedOutboundLink href="https://flowty.io/x" payload={{ surface: "moment", buyUrl: "https://real/buy" } as any}>
        go
      </TrackedOutboundLink>
    )
    fireEvent.click(container.querySelector("a")!)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ buyUrl: "https://real/buy" }))
  })

  // audit_20260930: the click is matched to the sale that follows it on
  // (collection, moment id). The wrapper must forward the collection it was
  // given — and must NOT invent one when the caller passed null.
  it("forwards the payload's collection to the beacon", () => {
    const { container } = render(
      <TrackedOutboundLink href="https://nflallday.com/moments/1" payload={{ surface: "moment", collection: "nfl_all_day", momentId: "1" }}>
        go
      </TrackedOutboundLink>
    )
    fireEvent.click(container.querySelector("a")!)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ collection: "nfl_all_day", momentId: "1" }))
  })

  it("keeps an explicit null collection null — never defaults it (e.g. to Top Shot)", () => {
    const { container } = render(
      <TrackedOutboundLink href="https://nbatopshot.com/moment/1" payload={{ surface: "moment", collection: null }}>
        go
      </TrackedOutboundLink>
    )
    fireEvent.click(container.querySelector("a")!)
    const sent = trackMock.mock.calls[0][0]
    expect(sent.collection).toBeNull()
  })
})
