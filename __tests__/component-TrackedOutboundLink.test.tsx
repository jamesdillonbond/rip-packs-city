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
})
