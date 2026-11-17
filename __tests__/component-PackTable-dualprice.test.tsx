// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// PackTable's exported cell components — the pieces the existing
// component-PackTable.test.tsx (sort / null / empty / availability badge)
// leaves uncovered:
//
//   · DualPriceCell — the pack price display. Its whole reason to exist is the
//     HONESTY rule that a legacy zero price shows an em-dash, NOT "$0.00", and
//     that primary inventory takes precedence over the secondary ask until it
//     runs out (then the live secondary shows with a "live" pip). A regression
//     here silently misprices every pack row a visitor sees.
//   · PackThumb — the art tile whose onError must fall back to the tier-colored
//     initial rather than a broken image.
// ─────────────────────────────────────────────────────────────────────────────

import { DualPriceCell, PackThumb } from "@/components/packs/PackTable"

type DualRow = Parameters<typeof DualPriceCell>[0]["row"]
function priceRow(o: Partial<DualRow>): DualRow {
  return {
    price: 0, primaryPrice: null, secondaryAsk: null, priceSource: null,
    primaryAvailable: null, secondaryAvailable: null, secondaryAskSource: null,
    secondaryListingCount: null, ...o,
  } as DualRow
}

afterEach(() => cleanup())

describe("DualPriceCell — honest pack pricing", () => {
  it("shows an em-dash for a legacy ZERO price (never $0.00)", () => {
    const { container } = render(<DualPriceCell row={priceRow({ price: 0 })} />)
    expect(container.textContent).toContain("—") // — not $0.00
    expect(container.textContent).not.toContain("$0")
  })

  it("shows the legacy single price when there is no dual-price data", () => {
    const { container } = render(<DualPriceCell row={priceRow({ price: 12.5 })} />)
    expect(container.textContent).toContain("12.5")
  })

  it("prefers the live PRIMARY price while inventory lasts", () => {
    const { container } = render(
      <DualPriceCell
        row={priceRow({
          priceSource: "primary", primaryAvailable: true, primaryPrice: 10,
          secondaryAvailable: true, secondaryAsk: 99,
        })}
      />
    )
    expect(container.textContent).toContain("10")
    expect(container.textContent).not.toContain("99") // secondary not shown while primary live
  })

  it("falls to the live SECONDARY ask once primary is unavailable, with a live pip", () => {
    const { container } = render(
      <DualPriceCell
        row={priceRow({
          priceSource: "secondary", primaryAvailable: false, primaryPrice: null,
          secondaryAvailable: true, secondaryAsk: 42, secondaryAskSource: "live",
        })}
      />
    )
    expect(container.textContent).toContain("42")
    // the live pip carries a title; assert its presence via the DOM
    expect(container.querySelector('[title="Live secondary low ask"]')).toBeTruthy()
  })

  it("shows an em-dash when priceSource is set but neither side is live", () => {
    const { container } = render(
      <DualPriceCell
        row={priceRow({ priceSource: "primary", primaryAvailable: false, secondaryAvailable: false })}
      />
    )
    expect(container.textContent).toContain("—")
  })
})

describe("PackThumb — art with a safe fallback", () => {
  it("renders the tier-colored initial when there is no url", () => {
    const { container } = render(<PackThumb url={null} tier="RARE" title="Base Set" />)
    expect(container.textContent).toBe("B") // first letter of title, uppercased
    expect(container.querySelector("img")).toBeNull()
  })

  it("renders '?' when there is neither url nor title", () => {
    const { container } = render(<PackThumb url={null} tier="COMMON" title="" />)
    expect(container.textContent).toBe("?")
  })

  it("renders the image, then falls back to the initial on error", () => {
    const { container } = render(<PackThumb url="https://cdn/pack.png" tier="LEGENDARY" title="Zion Pack" />)
    const img = container.querySelector("img") as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute("src")).toBe("https://cdn/pack.png")
    fireEvent.error(img)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("Z")
  })
})
