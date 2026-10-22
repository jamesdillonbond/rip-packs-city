// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { renderToString } from "react-dom/server"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import FmvHistoryChart from "@/components/entity/FmvHistoryChart"
import FmvHistoryPlot from "@/components/entity/FmvHistoryPlot"
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
    // 2026-10-21 RE-PIN (premise changed, not inverted): the plot is now
    // client-only (FmvHistoryPlot via next/dynamic ssr:false) so recharts is off
    // the page's critical path. The server renders the reserved 220 px box —
    // the chart branch, not an empty state — and no recharts at all.
    expect(html).toContain("height:220px")
    expect(html).not.toMatch(/Building price history|Couldn.{1,8}t load|Too few recorded sales/)
    expect(html).not.toContain("recharts-responsive-container")
    expect(n).toBe(0)
  })

  it("recharts stays off the edition page's critical path: no static import, plot is ssr:false", () => {
    // A test render cannot tell ssr:true from ssr:false (the lazy component never
    // resolves in renderToString), so the property is pinned at the source.
    const src = stripComments(readFileSync(path.join(process.cwd(), "components/entity/FmvHistoryChart.tsx"), "utf8"))
    expect(src).not.toMatch(/from ["']recharts["']/)
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(["']@\/components\/entity\/FmvHistoryPlot["']\)\s*,\s*\{[^}]*ssr:\s*false/)
  })

  it("FmvHistoryPlot (the recharts half) still starts at the box height — no size warning", () => {
    const series = days.map((d, i) => ({ label: d, value: 10 + i }))
    let html = ""
    const n = sizeWarnings(() => (html = renderToString(
      <FmvHistoryPlot series={series} source="fmv" showVolume={false} showRange={false} showAsp={false} showMa={false} showBuys={false} wallet={null} light={false} axis="#000" tick="#000" grid="#000" tipBg="#000" />,
    )))
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
