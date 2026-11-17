// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import PackShareButton from "@/components/packs/PackShareButton"

// PackShareButton copies the url to the clipboard and flips its label to
// "Copied" for ~1.6s. We stub navigator.clipboard.writeText to assert the copy
// and the label toggle.

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
})
afterEach(cleanup)

describe("PackShareButton", () => {
  it("starts as 'Copy link'", () => {
    const { getByRole } = render(<PackShareButton url="https://rippackscity.com/pack/1" />)
    expect(getByRole("button").textContent).toBe("Copy link")
  })

  it("writes the url to the clipboard and shows 'Copied' after a click", async () => {
    const { getByRole } = render(<PackShareButton url="https://rippackscity.com/pack/1" />)
    fireEvent.click(getByRole("button"))
    expect(writeText).toHaveBeenCalledWith("https://rippackscity.com/pack/1")
    await waitFor(() => expect(getByRole("button").textContent).toBe("Copied"))
  })
})
