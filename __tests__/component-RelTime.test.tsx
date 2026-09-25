// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { render, cleanup, waitFor } from "@testing-library/react"
import RelTime, { absoluteDateUtc } from "@/components/entity/RelTime"

// 2026-09-25: the SSR value used to be a literal "—", so every "When" cell of
// every Activity table read "—" in the served HTML (crawlers, unfurlers, no-JS
// readers). Two phases, like FreshnessStamp: a deterministic absolute date on
// the server and the first client render, the relative form after mount.

afterEach(() => cleanup())

describe("RelTime", () => {
  it("SSR carries a real, deterministic date — never a bare em-dash for a known timestamp", () => {
    const html = renderToStaticMarkup(<RelTime iso="2026-09-24T21:23:56.638Z" />)
    expect(html).toContain("Sep 24, 2026")
    expect(html).not.toContain("—")
  })

  it("swaps to the relative form after mount", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    const { container } = render(<RelTime iso={twoHoursAgo} />)
    await waitFor(() => expect(container.textContent).toMatch(/hours? ago/))
  })

  it("an absent timestamp is an em-dash in both phases", async () => {
    expect(renderToStaticMarkup(<RelTime iso={null} />)).toContain("—")
    const { container } = render(<RelTime iso={null} />)
    await waitFor(() => expect(container.textContent).toBe("—"))
  })

  it("absoluteDateUtc is built from UTC parts (no locale, no zone)", () => {
    expect(absoluteDateUtc("2026-01-01T00:30:00Z")).toBe("Jan 1, 2026")
    expect(absoluteDateUtc("2025-12-31T23:30:00-05:00")).toBe("Jan 1, 2026")
    expect(absoluteDateUtc("nonsense")).toBe("—")
    expect(absoluteDateUtc(undefined)).toBe("—")
  })
})
