// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { renderToString } from "react-dom/server"
import FmvHistoryChart from "@/components/entity/FmvHistoryChart"
import PinnacleFmvChart from "@/components/pinnacle/PinnacleFmvChart"

// recharts' ResponsiveContainer warns "The width(-1) and height(-1) of chart
// should be greater than 0 …" on every SERVER render when BOTH starting
// dimensions are <= 0 (default initialDimension -1 x -1). On 2026-10-14 prod
// logged one per edition-page render, burying real warnings; the earlier
// `minWidth={0}` "fix" never touched either dimension. These charts sit in
// fixed-height (220 px) wrappers, so they start with that height.
//
// The SERVER render is the subject, so this file runs in the node environment
// (no jsdom), the same as a Vercel function.

const SIZE_WARNING = "should be greater than 0"

function sizeWarnings(render: () => string): number {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    render()
    return spy.mock.calls.filter((c) => String(c[0]).includes(SIZE_WARNING)).length
  } finally {
    spy.mockRestore()
  }
}

const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]

afterEach(() => vi.restoreAllMocks())

describe("FMV charts server-render without recharts' size warning", () => {
  it("FmvHistoryChart (every collection's edition page)", () => {
    const initial = days.map((day, i) => ({
      day,
      fmv_usd: 10 + i,
      wap_usd: 10 + i,
      floor_usd: 9 + i,
      confidence: "HIGH" as const,
      sales_count_30d: 3,
      computed_at: day,
    }))
    let html = ""
    const n = sizeWarnings(() => (html = renderToString(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={initial} />)))
    // the chart branch rendered (not the empty state), so the container was exercised
    expect(html).toContain("recharts-responsive-container")
    expect(n).toBe(0)
  })

  it("PinnacleFmvChart (Pinnacle moment page)", () => {
    const points = days.map((d, i) => ({ computed_at: d, fmv_usd: 10 + i, fmv_confidence: "MEDIUM", fmv_sales_count_30d: 3 }))
    let html = ""
    const n = sizeWarnings(() => (html = renderToString(<PinnacleFmvChart points={points} />)))
    expect(html).toContain("recharts-responsive-container")
    expect(n).toBe(0)
  })
})
