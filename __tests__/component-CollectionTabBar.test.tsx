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

// 2026-11-07: at phone width the strip scrolls, and the active tab could sit
// past the fold with nothing lit in view (tap PACKS in the bottom bar → see
// OVERVIEW…PLAY, none active). The bar scrolls the active tab into view on
// arrival — only when the strip overflows AND the tab is out of view, so a
// desktop strip (no overflow) and an already-visible tab never scroll.
describe("CollectionTabBar — active tab comes into view", () => {
  // Geometry is faked on the PROTOTYPE before render, so the mount-time effect
  // sees it: the strip is 390 px wide holding 900 px of tabs; the active tab's
  // rect is either past the right edge or inside the strip.
  type Proto = HTMLElement & { scrollIntoView: HTMLElement["scrollIntoView"]; getBoundingClientRect: HTMLElement["getBoundingClientRect"] }
  const proto = HTMLElement.prototype as Proto
  let origScroll: HTMLElement["scrollIntoView"], origRect: HTMLElement["getBoundingClientRect"]
  let origSW: PropertyDescriptor | undefined, origCW: PropertyDescriptor | undefined
  const fakeGeometry = (activeOutside: boolean) => {
    origScroll = proto.scrollIntoView; origRect = proto.getBoundingClientRect
    origSW = Object.getOwnPropertyDescriptor(proto, "scrollWidth"); origCW = Object.getOwnPropertyDescriptor(proto, "clientWidth")
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get() { return this.tagName === "NAV" ? 900 : 0 } })
    Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.tagName === "NAV" ? 390 : 0 } })
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const r = (l: number, w: number) => ({ left: l, right: l + w, top: 0, bottom: 44, width: w, height: 44, x: l, y: 0, toJSON() {} }) as DOMRect
      if (this.tagName === "NAV") return r(0, 390)
      if (this.getAttribute?.("aria-selected") === "true") return activeOutside ? r(500, 80) : r(100, 80)
      return r(0, 80)
    }
  }
  const restore = () => {
    proto.scrollIntoView = origScroll; proto.getBoundingClientRect = origRect
    if (origSW) Object.defineProperty(proto, "scrollWidth", origSW); else Reflect.deleteProperty(proto, "scrollWidth")
    if (origCW) Object.defineProperty(proto, "clientWidth", origCW); else Reflect.deleteProperty(proto, "clientWidth")
  }

  it("scrolls an off-screen active tab into view when the strip overflows", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/market")
    fakeGeometry(true)
    const spy = vi.fn(); proto.scrollIntoView = spy
    try {
      render(<CollectionTabBar collection={collection} />)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toMatchObject({ block: "nearest" })
    } finally { restore() }
  })

  it("does NOT scroll when the active tab is already visible", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/market")
    fakeGeometry(false)
    const spy = vi.fn(); proto.scrollIntoView = spy
    try {
      render(<CollectionTabBar collection={collection} />)
      expect(spy).not.toHaveBeenCalled()
    } finally { restore() }
  })

  it("does NOT scroll when the strip fits (no overflow — desktop)", () => {
    pathnameMock.mockReturnValue("/nba-top-shot/market")
    const spy = vi.fn(); const orig = proto.scrollIntoView; proto.scrollIntoView = spy
    try {
      render(<CollectionTabBar collection={collection} />) // jsdom: scrollWidth === clientWidth === 0
      expect(spy).not.toHaveBeenCalled()
    } finally { proto.scrollIntoView = orig }
  })
})
