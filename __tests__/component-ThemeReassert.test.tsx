// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import ThemeReassert from "@/components/ThemeReassert"

beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme })
afterEach(cleanup)

describe("ThemeReassert", () => {
  it("puts data-theme=light back when the saved preference is light", () => {
    localStorage.setItem("rpc_theme", "light")
    render(<ThemeReassert />)
    expect(document.documentElement.dataset.theme).toBe("light")
  })
  it("leaves the default (dark, no attribute) alone when nothing is saved or dark is saved", () => {
    render(<ThemeReassert />)
    expect(document.documentElement.dataset.theme).toBeUndefined()
    cleanup()
    localStorage.setItem("rpc_theme", "dark")
    render(<ThemeReassert />)
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
