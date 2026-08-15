// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// SniperThumbnailPreview — measured at 0% statements before this file. It wraps
// every thumbnail in the sniper deal table, and everything it does happens on
// hover, so a plain render test would cover the wrapper and none of the logic.
//
// Two properties here are load-bearing rather than cosmetic:
//   1. the preview URL is REWRITTEN to width=400 and proxied — the table thumb
//      is a small-width CDN URL, so skipping the rewrite silently enlarges a
//      64px image into a 200px box;
//   2. the popup is CLAMPED to the viewport — it is `position: fixed`, so an
//      unclamped right edge puts the preview off-screen for any deal in the
//      last column, which is where the sniper table's price columns sit.

import { SniperThumbnailPreview } from "@/components/sniper/SniperThumbnailPreview"

const props = {
  playerName: "Damian Lillard",
  tierColor: "#E03A2F",
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true })
})
afterEach(cleanup)

/** Drive hover with a controlled bounding box (jsdom reports all zeroes). */
function hoverWith(container: HTMLElement, rect: Partial<DOMRect>) {
  const host = container.firstChild as HTMLElement
  host.getBoundingClientRect = () => ({ right: 0, top: 0, ...rect }) as DOMRect
  fireEvent.mouseEnter(host)
  return host
}

describe("SniperThumbnailPreview — always renders its children", () => {
  it("renders the wrapped thumbnail with no preview until hovered", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    expect(container.textContent).toContain("thumb")
    expect(container.querySelector("img")).toBeNull()
  })
})

describe("SniperThumbnailPreview — the hover preview", () => {
  it("requests a width=400 render, not the table's small thumbnail", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    hoverWith(container, { right: 100, top: 200 })
    const src = container.querySelector("img")!.getAttribute("src")!
    expect(src).toContain("width=400")
    expect(src).not.toContain("width=48")
  })

  it("labels the preview image with the player name", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    hoverWith(container, { right: 100, top: 200 })
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("Damian Lillard")
  })

  it("clamps the popup inside the viewport's right edge", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    // A thumbnail near the right edge: unclamped this would be 980 + 12 = 992,
    // putting a 200px-wide preview almost entirely off-screen.
    hoverWith(container, { right: 980, top: 300 })
    const pop = container.querySelectorAll("div")[1] as HTMLElement
    expect(pop.style.left).toBe("760px") // innerWidth(1000) - 240
  })

  it("clamps the popup below the viewport's top edge", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    // A row scrolled to the top: unclamped this would be 10 - 40 = -30.
    hoverWith(container, { right: 100, top: 10 })
    const pop = container.querySelectorAll("div")[1] as HTMLElement
    expect(pop.style.top).toBe("12px")
  })

  it("hides the preview again on mouse leave", () => {
    const { container } = render(
      <SniperThumbnailPreview thumbUrl="https://cdn.example/m.jpg?width=48" {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    const host = hoverWith(container, { right: 100, top: 200 })
    expect(container.querySelector("img")).not.toBeNull()
    fireEvent.mouseLeave(host)
    expect(container.querySelector("img")).toBeNull()
  })

  it("renders no preview at all for a moment with no thumbnail", () => {
    // The honest outcome: an absent thumbnail must not open an empty bordered
    // box that reads as a broken image.
    const { container } = render(
      <SniperThumbnailPreview thumbUrl={null} {...props}>
        <span>thumb</span>
      </SniperThumbnailPreview>,
    )
    hoverWith(container, { right: 100, top: 200 })
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("thumb")
  })
})
