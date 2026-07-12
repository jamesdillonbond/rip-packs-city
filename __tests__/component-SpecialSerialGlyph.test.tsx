// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"

// SpecialSerialGlyph categorizes a serial tag (accepting both the tag and
// badge_type vocabularies), dispatches art by platform (Top Shot inline SVG,
// All Day proxied <img>, everything else RPC-brand SVG), and returns null for
// unrecognized tags.

afterEach(cleanup)

describe("SpecialSerialGlyph", () => {
  it("returns null for an unrecognized tag", () => {
    expect(render(<SpecialSerialGlyph tag="nonsense" />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<SpecialSerialGlyph tag={null} />).container.firstChild).toBeNull()
  })

  it.each(["#1", "first", "first_serial"])("categorizes %s as a first-serial glyph", (tag) => {
    const { container } = render(<SpecialSerialGlyph tag={tag} collection="topshot" />)
    // Top Shot renders an inline SVG.
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("renders the All Day proxied badge image with the mapped slug", () => {
    const { container } = render(<SpecialSerialGlyph tag="jersey_match" collection="nfl-all-day" size={20} />)
    const img = container.querySelector("img")!
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("/api/badge-image?src=allday&name=player-number")
    expect(img.getAttribute("width")).toBe("20")
  })

  it.each([
    ["perfect", "perfect-serial"],
    ["last_serial", "perfect-serial"],
    ["#1", "first-serial"],
  ])("maps All Day tag %s to slug %s", (tag, slug) => {
    const { container } = render(<SpecialSerialGlyph tag={tag} collection="allday" />)
    expect(container.querySelector("img")!.getAttribute("src")).toContain(`name=${slug}`)
  })

  it("falls back to an RPC-brand SVG (not an <img>) for Golazos/UFC/Pinnacle", () => {
    const { container } = render(<SpecialSerialGlyph tag="perfect" collection="laliga-golazos" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("respects the size prop on the rendered SVG", () => {
    const { container } = render(<SpecialSerialGlyph tag="#1" collection="topshot" size={30} />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("width")).toBe("30")
    expect(svg.getAttribute("height")).toBe("30")
  })
})
