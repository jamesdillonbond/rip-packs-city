// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// BadgeIcon renders the taxonomy icon_url as an <img> when present; otherwise
// (or after the image errors) it degrades to a color-family pill showing the
// label. Unknown titles render as a neutral pill with the raw title. We stub
// the taxonomy so lookup results are deterministic.
const META: Record<string, any> = {
  WithIcon: { title: "With Icon", icon_url: "https://cdn.example/a.svg", color_family: "gold", description: "art badge" },
  NoIcon: { title: "No Icon", color_family: "blue", description: null },
}
vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: (_map: unknown, input: string) => META[input] ?? null,
  classesForColorFamily: (fam: string | null | undefined) => (fam ? `cf-${fam}` : "cf-neutral"),
}))

import BadgeIcon from "@/components/BadgeIcon"

afterEach(cleanup)

describe("BadgeIcon", () => {
  it("renders an <img> with the icon_url and canonical alt/title when art exists", () => {
    const { container } = render(<BadgeIcon title="WithIcon" size={24} />)
    const img = container.querySelector("img")!
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("https://cdn.example/a.svg")
    expect(img.getAttribute("alt")).toBe("With Icon")
    expect(img.getAttribute("title")).toBe("With Icon — art badge")
    expect(img.getAttribute("width")).toBe("24")
  })

  it("falls back to a color-family pill when the taxonomy has no icon_url", () => {
    const { container } = render(<BadgeIcon title="NoIcon" />)
    expect(container.querySelector("img")).toBeNull()
    const pill = container.querySelector("span")!
    expect(pill.textContent).toBe("No Icon")
    expect(pill.className).toContain("cf-blue")
  })

  it("degrades from <img> to the pill after the image errors", () => {
    const { container } = render(<BadgeIcon title="WithIcon" />)
    const img = container.querySelector("img")!
    fireEvent.error(img)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("span")!.textContent).toBe("With Icon")
  })

  it("renders an unknown title as a neutral pill using the raw title", () => {
    const { container } = render(<BadgeIcon title="Mystery" />)
    const pill = container.querySelector("span")!
    expect(pill.textContent).toBe("Mystery")
    expect(pill.className).toContain("cf-neutral")
  })
})
