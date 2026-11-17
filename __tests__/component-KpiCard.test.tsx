// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import KpiCard from "@/components/analytics/KpiCard"

afterEach(cleanup)

describe("KpiCard", () => {
  it("renders label, value and optional sublabel", () => {
    const { container } = render(
      <KpiCard label="Volume" value="$1.2M" sublabel="last 30 days" />
    )
    const txt = container.textContent!
    expect(txt).toContain("Volume")
    expect(txt).toContain("$1.2M")
    expect(txt).toContain("last 30 days")
  })

  it("omits the sublabel node when none is provided", () => {
    const { container } = render(<KpiCard label="Sales" value="42" />)
    expect(container.textContent).toContain("42")
    expect(container.textContent).not.toContain("last 30 days")
  })

  it("shows a positive delta with one decimal when delta >= 0", () => {
    const { container } = render(<KpiCard label="x" value="1" delta={3.14} />)
    // Delta rendered via Math.abs(...).toFixed(1) + "%"
    expect(container.textContent).toContain("3.1%")
  })

  it("renders the absolute value of a negative delta (sign shown via icon, not text)", () => {
    const { container } = render(<KpiCard label="x" value="1" delta={-7.25} />)
    expect(container.textContent).toContain("7.3%")
    // No literal minus sign in the delta text — direction is the ArrowDown icon.
    expect(container.textContent).not.toContain("-7.3%")
  })

  it("hides the delta chip when delta is null or non-finite", () => {
    const nullCase = render(<KpiCard label="x" value="1" delta={null} />)
    expect(nullCase.container.textContent).not.toContain("%")
    cleanup()
    const nanCase = render(<KpiCard label="x" value="1" delta={NaN} />)
    expect(nanCase.container.textContent).not.toContain("%")
  })

  it("treats delta exactly 0 as present and positive", () => {
    const { container } = render(<KpiCard label="x" value="1" delta={0} />)
    expect(container.textContent).toContain("0.0%")
  })
})
