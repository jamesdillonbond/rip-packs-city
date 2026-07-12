// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Stub next/link to a plain anchor so the link branch renders in jsdom.
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import { UserLabel } from "@/components/UserLabel"

// UserLabel renders a Flow wallet as a Top Shot @handle when a resolved name
// is supplied, otherwise a truncated 0x… address; a null address shows the
// emptyLabel. The `link` prop wraps the label in a /profile/<lc-addr> anchor.
// The title tooltip and monospace styling differ between the named and
// address-fallback paths.

afterEach(cleanup)

describe("UserLabel", () => {
  it("shows the emptyLabel for a null address (default em-dash)", () => {
    expect(render(<UserLabel address={null} />).container.textContent).toBe("—")
    cleanup()
    expect(render(<UserLabel address={undefined} emptyLabel="n/a" />).container.textContent).toBe("n/a")
  })

  it("renders @handle with a 'name · addr' tooltip when a name resolves", () => {
    const { container } = render(<UserLabel address="0xBD94CADE097E50AC" name="jamesdillonbond" />)
    const span = container.querySelector("span")!
    expect(span.textContent).toBe("@jamesdillonbond")
    expect(span.getAttribute("title")).toBe("jamesdillonbond · 0xbd94cade097e50ac")
    // named path does not force the mono font
    expect(span.getAttribute("style") || "").not.toContain("--font-mono")
  })

  it("truncates the lowercased address and applies mono font when no name is known", () => {
    const { container } = render(<UserLabel address="0xBD94CADE097E50AC" />)
    const span = container.querySelector("span")!
    expect(span.textContent).toBe("0xbd94…50ac")
    expect(span.getAttribute("title")).toBe("0xbd94cade097e50ac")
    expect(span.getAttribute("style")).toContain("--font-mono")
  })

  it("wraps the label in a /profile/<addr> link when link is set", () => {
    const { container } = render(<UserLabel address="0xBD94CADE097E50AC" name="trevor" link />)
    const anchor = container.querySelector("a")!
    expect(anchor.getAttribute("href")).toBe("/profile/0xbd94cade097e50ac")
    expect(anchor.textContent).toBe("@trevor")
  })
})
