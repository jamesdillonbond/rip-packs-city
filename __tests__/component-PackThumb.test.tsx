// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import PackThumb from "@/components/packs/PackThumb"

// PackThumb shows the image when a src is present, and falls back to a muted
// "Pack" placeholder for a null src OR after the image errors (dead pack art).

afterEach(cleanup)

describe("PackThumb", () => {
  it("renders the image when given a src", () => {
    const { container } = render(<PackThumb src="https://x/pack.png" alt="Base Pack" />)
    const img = container.querySelector("img")!
    expect(img.getAttribute("src")).toBe("https://x/pack.png")
    expect(img.getAttribute("alt")).toBe("Base Pack")
    expect(container.textContent).not.toContain("Pack ") // no placeholder text
  })

  it("renders the 'Pack' placeholder for a null src (no img element)", () => {
    const { container } = render(<PackThumb src={null} alt="Base Pack" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("Pack")
  })

  it("falls back to the placeholder after the image fails to load", () => {
    const { container } = render(<PackThumb src="https://dead/pack.png" alt="Base Pack" />)
    expect(container.querySelector("img")).not.toBeNull()
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("Pack")
  })

  // 10-28: over the tile's fixed rgba(0,0,0,0.3) the muted label read under 4.5:1 in light mode (the axe finding on
  // the same pattern in IpfsThumb / EditionsGridPaginated). The placeholder carries its own opaque theme surface.
  it("the placeholder label sits on an opaque theme surface", () => {
    const { getByText } = render(<PackThumb src={null} alt="Base Pack" />)
    expect((getByText("Pack") as HTMLElement).style.background).toBe("var(--rpc-surface)")
  })
})
