// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"

// FreshnessStamp emits a stable "—" on the server + first client render, then
// fills the localized date in an effect (the React #418 hydration-drift guard).

afterEach(() => cleanup())

describe("FreshnessStamp", () => {
  it("renders '—' for a null/undefined iso", async () => {
    const { container } = render(<FreshnessStamp iso={null} />)
    expect(container.textContent).toBe("—")
  })

  it("fills a localized date after mount for a valid iso", async () => {
    const { container } = render(<FreshnessStamp iso="2026-06-01T12:34:00Z" />)
    await waitFor(() => {
      expect(container.textContent).not.toBe("—")
    })
    // Localized "medium date / short time" contains the year.
    expect(container.textContent).toContain("2026")
  })
})
