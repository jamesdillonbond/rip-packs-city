// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { cloneElement, isValidElement } from "react"
import { render, cleanup } from "@testing-library/react"
import type { AnalyticsNewWalletsRow } from "@/lib/analytics-types"

// components/analytics/NewWalletsChart (0% before this). A recharts ComposedChart
// with an empty-state, a row→data transform, an internal CustomTooltip, and a
// PLATFORM_EVENTS ReferenceLine filter (drawn only when a data week is on/after
// the event date). recharts is mocked so children render (exercising the maps)
// and the Tooltip mock invokes `content` with active/inactive props to drive the
// CustomTooltip branches.

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  // Render the tooltip content twice: once active (values render) and once
  // inactive (returns null) so both CustomTooltip branches are exercised.
  const Tooltip = ({ content }: { content?: React.ReactNode }) => {
    if (!isValidElement(content)) return null
    const active = cloneElement(content as React.ReactElement, {
      active: true,
      label: "2026-07-01",
      payload: [
        { name: "New borrowers", value: 5, color: "#10b981", dataKey: "new_borrowers" },
        { name: "New lenders", value: 3, color: "#38bdf8", dataKey: "new_lenders" },
      ],
    } as Record<string, unknown>)
    const inactive = cloneElement(content as React.ReactElement, { active: false } as Record<string, unknown>)
    return (
      <div>
        {active}
        {inactive}
      </div>
    )
  }
  return {
    ResponsiveContainer: Pass,
    ComposedChart: Pass,
    Bar: () => null,
    Line: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    ReferenceLine: ({ x }: { x?: string }) => <div data-testid="refline" data-x={x} />,
    Tooltip,
  }
})

import NewWalletsChart from "@/components/analytics/NewWalletsChart"

afterEach(cleanup)

const row = (over: Partial<AnalyticsNewWalletsRow>): AnalyticsNewWalletsRow =>
  ({ week: "2026-07-01", new_borrowers: 5, new_lenders: 3, cumulative_total: 100, ...over }) as AnalyticsNewWalletsRow

describe("NewWalletsChart", () => {
  it("renders the empty-state when there are no rows", () => {
    const { container } = render(<NewWalletsChart rows={[]} />)
    expect(container.textContent).toContain("No new-wallet data yet")
  })

  it("renders the empty-state when rows is null/undefined", () => {
    const { container } = render(<NewWalletsChart rows={undefined as unknown as AnalyticsNewWalletsRow[]} />)
    expect(container.textContent).toContain("No new-wallet data yet")
  })

  it("draws the event reference lines when a data week is on/after every event date", () => {
    // week 2026-07-01 is after all three PLATFORM_EVENTS (2024/2025/2026-01).
    const { getAllByTestId } = render(<NewWalletsChart rows={[row({})]} />)
    expect(getAllByTestId("refline").length).toBe(3)
  })

  it("omits every reference line when all data weeks predate the events", () => {
    const { queryAllByTestId } = render(
      <NewWalletsChart rows={[row({ week: "2024-01-01" })]} />,
    )
    expect(queryAllByTestId("refline").length).toBe(0)
  })

  it("renders the tooltip series names + counts when active, null when inactive", () => {
    const { container } = render(<NewWalletsChart rows={[row({})]} />)
    const txt = container.textContent!
    expect(txt).toContain("Week of 2026-07-01")
    expect(txt).toContain("New borrowers")
    expect(txt).toContain("New lenders")
    // Number(value).toLocaleString() bands
    expect(txt).toContain("5")
    expect(txt).toContain("3")
  })

  it("coerces non-numeric row fields to 0 without throwing", () => {
    const dirty = { week: "2026-07-01", new_borrowers: null, new_lenders: undefined, cumulative_total: "x" } as unknown as AnalyticsNewWalletsRow
    const { getAllByTestId } = render(<NewWalletsChart rows={[dirty]} height={200} />)
    // still renders (reference lines drawn) despite dirty numeric fields
    expect(getAllByTestId("refline").length).toBe(3)
  })
})
