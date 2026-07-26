// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import NetOfFeesNote from "@/components/sniper/NetOfFeesNote"
import type { SniperDeal } from "@/lib/sniper/types"

// The sniper card's fee-net note. The component's whole job is to be honest
// about a number the rest of the card states gross, so the tests that matter
// are the ones asserting it renders NOTHING rather than a guess.

type Net = NonNullable<SniperDeal["netOfFees"]>

const net = (over: Partial<Net> = {}): Net => ({
  feePct: 0.05,
  netIfResold: 95,
  netMarginUsd: 15,
  netMarginPct: 18.8,
  flipsNegative: false,
  ...over,
})

afterEach(() => cleanup())

describe("NetOfFeesNote", () => {
  it("renders nothing when the collection has no verified fee rate", () => {
    const { container } = render(<NetOfFeesNote net={null} />)
    expect(container.innerHTML).toBe("")
  })

  it("renders nothing when netOfFees is absent entirely", () => {
    const { container } = render(<NetOfFeesNote net={undefined} />)
    expect(container.innerHTML).toBe("")
  })

  it("states the positive net margin and the rate that produced it", () => {
    render(<NetOfFeesNote net={net()} />)
    expect(screen.getByText(/net \+\$15\.00 after 5% fee/)).toBeTruthy()
  })

  it("calls out a gross discount that does NOT survive the fee", () => {
    render(<NetOfFeesNote net={net({ netMarginUsd: -2.4, netMarginPct: -2.5, netIfResold: 95, flipsNegative: true })} />)
    const el = screen.getByText(/net −\$2\.40 after 5% fee/)
    expect(el).toBeTruthy()
    // The warning case must be visually distinct, not just differently worded.
    expect((el as HTMLElement).style.color).toContain("rpc-warning")
  })

  it("renders Pinnacle's fractional rate without dropping the decimal", () => {
    render(<NetOfFeesNote net={net({ feePct: 0.075 })} />)
    expect(screen.getByText(/after 7\.5% fee/)).toBeTruthy()
  })

  it("drops cents on large figures and keeps them on small ones", () => {
    const { rerender } = render(<NetOfFeesNote net={net({ netMarginUsd: 1240.5 })} />)
    expect(screen.getByText(/net \+\$1241 after/)).toBeTruthy()
    rerender(<NetOfFeesNote net={net({ netMarginUsd: 0.5 })} />)
    expect(screen.getByText(/net \+\$0\.50 after/)).toBeTruthy()
  })

  it("carries an explanatory title on both branches", () => {
    const { rerender, container } = render(<NetOfFeesNote net={net()} />)
    expect(container.querySelector("span")?.getAttribute("title")).toMatch(/return on what you put in/)
    rerender(<NetOfFeesNote net={net({ flipsNegative: true })} />)
    expect(container.querySelector("span")?.getAttribute("title")).toMatch(/does not survive the fee/)
  })
})
