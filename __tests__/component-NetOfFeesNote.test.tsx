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

  it("shows a NEGATIVE net on a zero-spread row, where flipsNegative is false", () => {
    // deep-audit D9, the dominant case on the Top Shot sniper: ASK $5.00 /
    // FMV $5.00. The 5% fee leaves $4.75, so the margin is −$0.25 — but
    // flipsNegative requires f > a, which is false at zero spread, so the old
    // code took the positive branch and Math.abs printed "net +$0.25".
    render(
      <NetOfFeesNote
        net={net({ netIfResold: 4.75, netMarginUsd: -0.25, netMarginPct: -5, flipsNegative: false })}
      />,
    )
    expect(screen.getByText(/net −\$0\.25 after 5% fee/)).toBeTruthy()
    expect(screen.queryByText(/net \+/)).toBeNull()
  })

  it("does not call a zero-spread row a discount that failed to survive the fee", () => {
    // The wording must still distinguish the two negatives: an eroded discount
    // vs. never having had one.
    const { container } = render(
      <NetOfFeesNote net={net({ netIfResold: 4.75, netMarginUsd: -0.25, flipsNegative: false })} />,
    )
    const title = container.querySelector("span")?.getAttribute("title") ?? ""
    expect(title).toMatch(/no discount here to survive the fee/)
    expect(title).not.toMatch(/does not survive the fee\./)
  })

  it("carries an explanatory title on both branches", () => {
    const { rerender, container } = render(<NetOfFeesNote net={net()} />)
    expect(container.querySelector("span")?.getAttribute("title")).toMatch(/return on what you put in/)
    // NB: flipsNegative is `f > a && netMarginUsd <= 0` upstream, so it can never
    // co-occur with a positive margin. The old fixture left the default
    // netMarginUsd: 15 here and asserted the warning title anyway — an
    // impossible state that only passed because the component branched on the
    // flag alone. Give it a margin consistent with the flag.
    rerender(<NetOfFeesNote net={net({ netMarginUsd: -2.4, netIfResold: 95, flipsNegative: true })} />)
    expect(container.querySelector("span")?.getAttribute("title")).toMatch(/does not survive the fee/)
  })
})
