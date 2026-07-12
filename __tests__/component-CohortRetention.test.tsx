// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import CohortRetention from "@/components/analytics/CohortRetention"

afterEach(cleanup)

function cell(overrides: Record<string, any> = {}) {
  return {
    cohort_month: "2026-01-01",
    cohort_size: 100,
    month_offset: 0,
    active_count: 100,
    retention_pct: 100,
    ...overrides,
  } as any
}

describe("CohortRetention", () => {
  it("renders an empty state when there are no rows", () => {
    const { container } = render(<CohortRetention rows={[]} />)
    expect(container.textContent).toContain("Cohort table populates after the first monthly cohort completes.")
  })

  it("pivots rows into a month-labeled cohort with size and M-offset headers", () => {
    const rows = [
      cell({ month_offset: 0, retention_pct: 100, active_count: 100 }),
      cell({ month_offset: 1, retention_pct: 42, active_count: 42 }),
    ]
    const { container } = render(<CohortRetention rows={rows} />)
    const txt = container.textContent!
    // monthLabel("2026-01-01") -> "Jan 2026"
    expect(txt).toContain("Jan 2026")
    expect(txt).toContain("100") // size
    // Header offsets M0..M1 (maxOffset = 1)
    expect(txt).toContain("M0")
    expect(txt).toContain("M1")
    // retention rounded to whole percent
    expect(txt).toContain("42%")
  })

  it("renders a placeholder dot for a missing (offset) cell", () => {
    // Cohort has only M0 present but another cohort pushes maxOffset to 2,
    // so this cohort's M1/M2 cells are absent and render "·".
    const rows = [
      cell({ cohort_month: "2026-01-01", month_offset: 0 }),
      cell({ cohort_month: "2026-02-01", month_offset: 2, retention_pct: 10 }),
    ]
    const { container } = render(<CohortRetention rows={rows} />)
    expect(container.textContent).toContain("·")
    expect(container.textContent).toContain("Feb 2026")
    expect(container.textContent).toContain("M2")
  })

  it("sorts cohorts ascending by month and dedups size across rows", () => {
    const rows = [
      cell({ cohort_month: "2026-03-01", cohort_size: 50, month_offset: 0 }),
      cell({ cohort_month: "2026-01-01", cohort_size: 200, month_offset: 0 }),
    ]
    const { container } = render(<CohortRetention rows={rows} />)
    const txt = container.textContent!
    const janIdx = txt.indexOf("Jan 2026")
    const marIdx = txt.indexOf("Mar 2026")
    expect(janIdx).toBeGreaterThanOrEqual(0)
    expect(marIdx).toBeGreaterThan(janIdx)
    expect(txt).toContain("200")
    expect(txt).toContain("50")
  })

  it("renders the retention-heat legend ranges", () => {
    const { container } = render(<CohortRetention rows={[cell()]} />)
    const txt = container.textContent!
    expect(txt).toContain("<10%")
    expect(txt).toContain("80%+")
  })
})
