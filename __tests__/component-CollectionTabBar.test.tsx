// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Stub next/link → anchor; usePathname is driven per-test via a hoisted mock.
const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }))
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))
vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock() }))

import { CollectionTabBar } from "@/components/collection-tab-bar"
import { PAGE_LABELS } from "@/lib/collections"

// CollectionTabBar renders one tab per collection.pages entry, marks the tab
// matching the current pathname aria-selected (overview also matches the bare
// /<id> root), labels each tab via PAGE_LABELS, and anchors only the sniper
// tab for the product tour.

afterEach(cleanup)

const collection = {
  id: "nba-top-shot",
  accent: "#E03A2F",
  pages: ["overview", "sniper", "market"],
} as any

function tabByLabel(container: HTMLElement, label: string): HTMLAnchorElement {
  return Array.from(container.querySelectorAll("a")).find((a) => a.textContent === label)! as HTMLAnchorElement
}

describe("CollectionTabBar", () => {
  it("renders a labelled tab per page with the correct hrefs", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/sniper")
    const { container } = render(<CollectionTabBar collection={collection} />)
    const anchors = Array.from(container.querySelectorAll("a"))
    expect(anchors.map((a) => a.textContent)).toEqual([
      PAGE_LABELS.overview,
      PAGE_LABELS.sniper,
      PAGE_LABELS.market,
    ])
    expect(tabByLabel(container, PAGE_LABELS.market).getAttribute("href")).toBe("/nba-top-shot/market")
  })

  it("marks the active tab aria-selected and leaves the others unselected", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/sniper")
    const { container } = render(<CollectionTabBar collection={collection} />)
    expect(tabByLabel(container, PAGE_LABELS.sniper).getAttribute("aria-selected")).toBe("true")
    expect(tabByLabel(container, PAGE_LABELS.market).getAttribute("aria-selected")).toBe("false")
  })

  it("treats the bare /<id> root as the overview tab being active", () => {
    pathnameMock.mockReturnValue("/nba-top-shot")
    const { container } = render(<CollectionTabBar collection={collection} />)
    expect(tabByLabel(container, PAGE_LABELS.overview).getAttribute("aria-selected")).toBe("true")
  })

  it("anchors only the sniper tab for the product tour", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/overview")
    const { container } = render(<CollectionTabBar collection={collection} />)
    expect(tabByLabel(container, PAGE_LABELS.sniper).getAttribute("data-tour-anchor")).toBe("sniper-nav-link")
    expect(tabByLabel(container, PAGE_LABELS.market).getAttribute("data-tour-anchor")).toBeNull()
  })
})
