// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import WalletIdenticon from "@/components/analytics/WalletIdenticon"

afterEach(cleanup)

function rects(container: HTMLElement): SVGRectElement[] {
  return Array.from(container.querySelectorAll("rect"))
}

describe("WalletIdenticon", () => {
  it("is deterministic — the same address renders an identical grid", () => {
    const a = render(<WalletIdenticon addr="0x1234567890abcdef" />)
    const first = rects(a.container).map((r) => `${r.getAttribute("x")},${r.getAttribute("y")}`).sort()
    cleanup()
    const b = render(<WalletIdenticon addr="0x1234567890abcdef" />)
    const second = rects(b.container).map((r) => `${r.getAttribute("x")},${r.getAttribute("y")}`).sort()
    expect(second).toEqual(first)
  })

  it("mirrors filled cells horizontally within each row (columns 0<->3, 1<->2)", () => {
    const { container } = render(<WalletIdenticon addr="0x1234567890abcdef" size={48} />)
    const cell = 48 / 4
    const filled = new Set(
      rects(container).map(
        (r) => `${Math.round(Number(r.getAttribute("x")) / cell)}-${Math.round(Number(r.getAttribute("y")) / cell)}`
      )
    )
    for (let row = 0; row < 4; row++) {
      expect(filled.has(`0-${row}`)).toBe(filled.has(`3-${row}`))
      expect(filled.has(`1-${row}`)).toBe(filled.has(`2-${row}`))
    }
  })

  it("scales the svg and cell geometry to the size prop", () => {
    const { container } = render(<WalletIdenticon addr="0xffffffffffffffff" size={80} />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("width")).toBe("80")
    expect(svg.getAttribute("height")).toBe("80")
    // With all-odd bytes every cell is filled -> 16 rects, each 20px wide.
    const rs = rects(container)
    expect(rs.length).toBe(16)
    expect(rs[0].getAttribute("width")).toBe("20")
  })

  it("tolerates an empty/garbage address by padding to zero bytes (no filled cells)", () => {
    const { container } = render(<WalletIdenticon addr="" />)
    // Padded to "0000..." -> every byte even -> no rects rendered.
    expect(rects(container).length).toBe(0)
    // Container still renders the wrapper svg.
    expect(container.querySelector("svg")).toBeTruthy()
  })
})
