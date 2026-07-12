// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// next/link → plain anchor so the trail renders without the Next runtime.
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import Breadcrumbs from "@/components/entity/Breadcrumbs"

afterEach(cleanup)

describe("Breadcrumbs", () => {
  it("renders nothing when there are no named crumbs", () => {
    const { container } = render(<Breadcrumbs items={[{ name: "" }, { name: "" }]} />)
    expect(container.firstChild).toBeNull()
  })

  it("drops empty-named crumbs and keeps the named ones", () => {
    const { container } = render(
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "", href: "/x" }, { name: "Base Set" }]} />
    )
    const txt = container.textContent!
    expect(txt).toContain("Home")
    expect(txt).toContain("Base Set")
  })

  it("links every crumb except the last, which is plain text with aria-current=page", () => {
    const { container } = render(
      <Breadcrumbs items={[
        { name: "Home", href: "/" },
        { name: "Sets", href: "/nba-top-shot/set" },
        { name: "Base Set", href: "/nba-top-shot/set/base-set" },
      ]} />
    )
    const links = container.querySelectorAll("a")
    // Only the first two are links even though the last one has an href.
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute("href")).toBe("/")
    const current = container.querySelector('[aria-current="page"]')!
    expect(current.textContent).toBe("Base Set")
  })

  it("renders a separator between crumbs but not after the last", () => {
    const { container } = render(
      <Breadcrumbs items={[{ name: "A", href: "/a" }, { name: "B", href: "/b" }, { name: "C" }]} />
    )
    // Two crumbs precede the last → two separators.
    const seps = container.querySelectorAll('[aria-hidden="true"]')
    expect(seps).toHaveLength(2)
  })

  it("renders a single crumb as plain current-page text with no separators", () => {
    const { container } = render(<Breadcrumbs items={[{ name: "Only", href: "/only" }]} />)
    expect(container.querySelectorAll("a")).toHaveLength(0)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
    expect(container.querySelector('[aria-current="page"]')!.textContent).toBe("Only")
  })
})
