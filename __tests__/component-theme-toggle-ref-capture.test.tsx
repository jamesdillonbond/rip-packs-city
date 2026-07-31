// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import ThemeToggle from "@/components/ThemeToggle"
import RefCapture from "@/components/RefCapture"

// Two headless/near-headless top-level components with real branch logic:
// ThemeToggle (the light/dark attribute + localStorage flip) and RefCapture
// (the ?ref=<uuid> validation + one-shot localStorage stash).

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  delete document.documentElement.dataset.theme
  window.history.replaceState({}, "", "/")
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ThemeToggle", () => {
  it("defaults to dark and offers switch-to-light", () => {
    const { getByRole } = render(<ThemeToggle />)
    expect(getByRole("button").getAttribute("aria-label")).toBe("Switch to light mode")
  })

  it("clicking flips to light — sets the attribute + localStorage", () => {
    const { getByRole } = render(<ThemeToggle />)
    fireEvent.click(getByRole("button"))
    expect(document.documentElement.dataset.theme).toBe("light")
    expect(localStorage.getItem("rpc_theme")).toBe("light")
    expect(getByRole("button").getAttribute("aria-label")).toBe("Switch to dark mode")
  })

  it("clicking again flips back to dark — removes the attribute", () => {
    const { getByRole } = render(<ThemeToggle />)
    fireEvent.click(getByRole("button")) // -> light
    fireEvent.click(getByRole("button")) // -> dark
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(localStorage.getItem("rpc_theme")).toBe("dark")
  })

  it("reads an already-applied light theme on mount", () => {
    document.documentElement.dataset.theme = "light"
    const { getByRole } = render(<ThemeToggle />)
    expect(getByRole("button").getAttribute("aria-label")).toBe("Switch to dark mode")
  })
})

describe("RefCapture", () => {
  it("stashes a valid ?ref uuid into localStorage and renders nothing", () => {
    const uuid = "abcdef01-2345-6789-abcd-ef0123456789"
    window.history.replaceState({}, "", `/?ref=${uuid}`)
    const { container } = render(<RefCapture />)
    expect(container.firstChild).toBeNull()
    expect(localStorage.getItem("rpc_ref")).toBe(uuid)
  })

  it("ignores a malformed ref", () => {
    window.history.replaceState({}, "", "/?ref=not-a-uuid")
    render(<RefCapture />)
    expect(localStorage.getItem("rpc_ref")).toBeNull()
  })

  it("does not overwrite an existing ref (first-touch wins)", () => {
    localStorage.setItem("rpc_ref", "11111111-2222-3333-4444-555555555555")
    window.history.replaceState({}, "", "/?ref=abcdef01-2345-6789-abcd-ef0123456789")
    render(<RefCapture />)
    expect(localStorage.getItem("rpc_ref")).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("no ref param → nothing stored", () => {
    render(<RefCapture />)
    expect(localStorage.getItem("rpc_ref")).toBeNull()
  })
})
