// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// SpecialSerialGlyph is a heavy per-collection badge-art component (inline SVGs
// / CDN URLs). Stub it to a marker so we can assert WHETHER SerialBadge chose to
// render a glyph and WHICH tag it mapped to, without pulling in the art.
vi.mock("@/components/SpecialSerialGlyph", () => ({
  default: ({ tag }: { tag: string }) => <i data-testid="glyph" data-tag={tag} />,
}))

import { SerialBadge } from "@/components/sniper/SerialBadge"

// A SniperDeal is a big type; only these fields drive SerialBadge, so build a
// minimal object and cast.
function deal(overrides: Record<string, unknown> = {}): any {
  return { isSpecialSerial: false, serialMult: 1, serialSignal: null, ...overrides }
}

afterEach(cleanup)

describe("SerialBadge", () => {
  it("renders nothing for an ordinary serial (not special, multiplier <= 1)", () => {
    const { container } = render(<SerialBadge deal={deal({ isSpecialSerial: false, serialMult: 1 })} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the multiplier pill when serialMult > 1 even without a special flag", () => {
    const { container } = render(<SerialBadge deal={deal({ serialMult: 2.5 })} />)
    // No serialSignal → falls back to the ×N.N formatting.
    expect(container.textContent).toContain("×2.5")
    // Not special → no leading glyph.
    expect(container.querySelector('[data-testid="glyph"]')).toBeNull()
  })

  it.each([
    ["#1 First Mint", "#1"],
    ["Jersey #12", "jersey"],
    ["Last #499", "last_mint"],
  ])("maps the special serialSignal %s to glyph tag %s and shows the signal text", (signal, tag) => {
    const { container } = render(<SerialBadge deal={deal({ isSpecialSerial: true, serialSignal: signal })} />)
    const glyph = container.querySelector('[data-testid="glyph"]')!
    expect(glyph.getAttribute("data-tag")).toBe(tag)
    expect(container.textContent).toContain(signal)
  })

  it("omits the glyph for a special serial whose signal maps to no known tag", () => {
    const { container } = render(<SerialBadge deal={deal({ isSpecialSerial: true, serialSignal: "Weird" })} />)
    expect(container.querySelector('[data-testid="glyph"]')).toBeNull()
    expect(container.textContent).toContain("Weird")
  })
})
