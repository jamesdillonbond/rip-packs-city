// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PinnacleFmvChart, { fmtUsd, fmtDay, type PinnacleFmvPoint } from "@/components/pinnacle/PinnacleFmvChart"

// Pins the Pinnacle FMV chart's money formatter (the $0.00-silently risk) and
// its "too few points" empty state. The formatter is otherwise only reachable
// through recharts' internal tick/tooltip callbacks.

afterEach(cleanup)

describe("PinnacleFmvChart.fmtUsd", () => {
  it("returns — for null / undefined / non-finite (never $0.00 or $NaN)", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
    expect(fmtUsd(Number.NaN)).toBe("—")
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe("—")
  })
  it("uses cents below $100", () => {
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(4.2)).toBe("$4.20")
    expect(fmtUsd(99.99)).toBe("$99.99")
  })
  it("rounds whole dollars in [100,1000)", () => {
    expect(fmtUsd(100)).toBe("$100")
    expect(fmtUsd(249.6)).toBe("$250")
  })
  it("uses $Xk at/above 1000", () => {
    expect(fmtUsd(1000)).toBe("$1.0k")
    expect(fmtUsd(2500)).toBe("$2.5k")
  })
})

describe("PinnacleFmvChart.fmtDay", () => {
  it("formats a valid ISO date as 'Mon D'", () => {
    expect(fmtDay("2026-07-04T00:00:00Z")).toMatch(/Jul\s+\d+/)
  })
  it("returns the raw input for an unparseable date", () => {
    expect(fmtDay("not-a-date")).toBe("not-a-date")
  })
  // Regression: the daily FMV axis must render the UTC calendar day, so a point
  // near UTC midnight doesn't slip a day west of UTC. Force a US zone so this
  // bites regardless of the CI runner's TZ.
  it("renders the UTC day for an instant near midnight, even west of UTC", () => {
    const origTZ = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      expect(fmtDay("2026-07-01T02:00:00.000Z")).toBe("Jul 1")
    } finally {
      process.env.TZ = origTZ
    }
  })
})

describe("PinnacleFmvChart empty state", () => {
  const pt = (fmv: number | null, day: string): PinnacleFmvPoint => ({
    computed_at: day,
    fmv_usd: fmv,
    fmv_confidence: "MEDIUM",
    fmv_sales_count_30d: 3,
  })

  it("shows the 'too few FMV points' note when <=2 finite points survive the filter", () => {
    const { container } = render(
      <PinnacleFmvChart
        points={[pt(10, "2026-07-01"), pt(null, "2026-07-02"), pt(12, "2026-07-03")]}
      />,
    )
    // only 2 finite points -> empty state
    expect(container.textContent).toContain("too few FMV points")
  })

  it("does NOT show the empty note when 3+ finite points exist", () => {
    const { container } = render(
      <PinnacleFmvChart
        points={[pt(10, "2026-07-01"), pt(11, "2026-07-02"), pt(12, "2026-07-03")]}
      />,
    )
    expect(container.textContent).not.toContain("too few FMV points")
  })
})
