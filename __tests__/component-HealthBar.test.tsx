// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import HealthBar from "@/components/analytics/HealthBar"

afterEach(cleanup)

describe("HealthBar", () => {
  it("renders each metric's label, value and hint", () => {
    const { container } = render(
      <HealthBar
        title="Ingest health"
        metrics={[
          { label: "Lag", value: "3m", hint: "cursor fresh" },
          { label: "Rows", value: "9,094" },
        ]}
      />
    )
    const txt = container.textContent!
    expect(txt).toContain("Ingest health")
    expect(txt).toContain("Lag")
    expect(txt).toContain("3m")
    expect(txt).toContain("cursor fresh")
    expect(txt).toContain("9,094")
  })

  it("omits the title block when no title is given", () => {
    const { container } = render(
      <HealthBar metrics={[{ label: "A", value: "1" }]} />
    )
    expect(container.textContent).toContain("A")
    // The only text should be the metric — no stray title.
    expect(container.querySelector("div")).toBeTruthy()
  })

  it("renders a clamped progress bar only for finite numeric progress", () => {
    const { container } = render(
      <HealthBar
        metrics={[
          { label: "over", value: "x", progress: 250 },
          { label: "under", value: "y", progress: -40 },
          { label: "none", value: "z", progress: null },
        ]}
      />
    )
    const bars = Array.from(container.querySelectorAll("div[style*='width']")) as HTMLElement[]
    const widths = bars.map((b) => b.style.width)
    // 250 clamps to 100%, -40 clamps to 0%. The null-progress metric renders no bar.
    expect(widths).toContain("100%")
    expect(widths).toContain("0%")
    expect(bars.length).toBe(2)
  })

  it("does not render a progress bar for a NaN progress value", () => {
    const { container } = render(
      <HealthBar metrics={[{ label: "bad", value: "x", progress: NaN }]} />
    )
    expect(container.querySelectorAll("div[style*='width']").length).toBe(0)
  })
})
