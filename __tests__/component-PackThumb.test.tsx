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
})
