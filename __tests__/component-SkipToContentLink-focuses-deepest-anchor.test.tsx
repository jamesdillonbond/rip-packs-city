// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import SkipToContentLink from "@/components/SkipToContentLink"
import { PAGE_CONTENT_ANCHOR_ATTR } from "@/components/skip-to-content-attr"

// The skip link's job (UI audit 2026-10-24, P1-1): 13 layouts mount the site header INSIDE
// {children}, so the root #main-content jump lands ABOVE the chrome it exists to skip. On click the
// link must focus the LAST page-content anchor in document order (the deepest layout's), and when a
// page has none it must NOT swallow the click, so the browser's native fragment jump still works.
afterEach(cleanup)

function renderWithAnchors(n: number) {
  return render(
    <div>
      <SkipToContentLink href="#main-content" className="skip">Skip to content</SkipToContentLink>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} id={`anchor-${i}`} tabIndex={-1} {...{ [PAGE_CONTENT_ANCHOR_ATTR]: "" }} />
      ))}
    </div>,
  )
}

describe("SkipToContentLink — lands past the chrome, never on the first anchor", () => {
  it("focuses the LAST anchor in document order and cancels the fragment jump", () => {
    const { getByText, container } = renderWithAnchors(3)
    const notCancelled = fireEvent.click(getByText("Skip to content"))
    expect(notCancelled).toBe(false)
    expect(document.activeElement).toBe(container.querySelector("#anchor-2"))
    expect(document.activeElement).not.toBe(container.querySelector("#anchor-0"))
  })

  it("with no page anchor, leaves the click alone so the native #main-content jump still happens", () => {
    const { getByText } = renderWithAnchors(0)
    const before = document.activeElement
    const notCancelled = fireEvent.click(getByText("Skip to content"))
    expect(notCancelled).toBe(true)
    expect(document.activeElement).toBe(before)
  })

  it("keeps the href, so the link still works before JS loads", () => {
    const { getByText } = renderWithAnchors(1)
    expect(getByText("Skip to content").getAttribute("href")).toBe("#main-content")
  })
})
