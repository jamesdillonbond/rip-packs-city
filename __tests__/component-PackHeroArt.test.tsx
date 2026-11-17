// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import PackHeroArt from "@/components/packs/PackHeroArt"

// PackHeroArt is a three-tier graceful-fallback: (1) primary <img>; on its
// error → (2) a montage grid of pool thumbnails; when those are absent/all-dead
// → (3) a tier-tinted tile showing the pack title's initial. tier-style is a
// pure lookup, so we exercise the real component end-to-end.

afterEach(cleanup)

const montage = ["https://a/1.png", "https://a/2.png"]

describe("PackHeroArt", () => {
  it("renders the primary image when a url is supplied and loads", () => {
    const { container } = render(
      <PackHeroArt url="https://x/hero.png" tier="COMMON" title="Base Pack" montage={montage} />
    )
    const imgs = container.querySelectorAll("img")
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute("src")).toBe("https://x/hero.png")
  })

  it("falls back to the montage grid when the primary image errors", () => {
    const { container } = render(
      <PackHeroArt url="https://x/dead.png" tier="RARE" title="Rare Pack" montage={montage} />
    )
    fireEvent.error(container.querySelector("img")!)
    // Now the two montage thumbs render.
    const imgs = container.querySelectorAll("img")
    expect(imgs).toHaveLength(2)
    expect(imgs[0].getAttribute("src")).toBe("https://a/1.png")
  })

  it("renders the branded initial tile when there is no url and no montage", () => {
    const { container } = render(
      <PackHeroArt url={null} tier="COMMON" title="grail pack" montage={[]} />
    )
    expect(container.querySelector("img")).toBeNull()
    // Initial is uppercased.
    expect(container.textContent).toBe("G")
  })

  it("degrades from an all-dead montage to the initial tile", () => {
    const { container } = render(
      <PackHeroArt url={null} tier="COMMON" title="xander" montage={["https://a/dead1.png"]} />
    )
    // One montage img renders first.
    expect(container.querySelectorAll("img")).toHaveLength(1)
    fireEvent.error(container.querySelector("img")!)
    // All montage thumbs dead → initial tile.
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("X")
  })

  it("uses '?' as the initial when the title is empty", () => {
    const { container } = render(<PackHeroArt url={null} tier="COMMON" title="" montage={[]} />)
    expect(container.textContent).toBe("?")
  })
})
