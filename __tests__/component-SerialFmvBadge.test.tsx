// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import SerialFmvBadge from "@/components/SerialFmvBadge"

// SerialFmvBadge shows an estimated #1 / perfect-mint premium. It renders
// nothing without a finite estimate, tags "first" vs "perfect", folds the
// multiplier into the tooltip when finite, and formats the estimate as a
// rounded whole-dollar figure.

afterEach(cleanup)

describe("SerialFmvBadge", () => {
  it("renders nothing when data is missing or the estimate is non-finite", () => {
    expect(render(<SerialFmvBadge data={null} />).container.firstChild).toBeNull()
    cleanup()
    expect(
      render(<SerialFmvBadge data={{ estimate_usd: NaN, multiplier: 2, serial_bucket: "first" }} />).container.firstChild
    ).toBeNull()
  })

  it("tags a #1 estimate and rounds the estimate to whole dollars", () => {
    const { container } = render(
      <SerialFmvBadge data={{ estimate_usd: 1234.7, multiplier: 3.5, serial_bucket: "first" }} />
    )
    expect(container.textContent).toContain("#1 est")
    expect(container.textContent).toContain("$1,235")
  })

  it("tags a perfect-mint estimate", () => {
    const { container } = render(
      <SerialFmvBadge data={{ estimate_usd: 500, multiplier: 2, serial_bucket: "perfect" }} />
    )
    expect(container.textContent).toContain("perfect est")
  })

  it("includes the multiplier in the tooltip when finite, omits it when not", () => {
    const withMult = render(
      <SerialFmvBadge data={{ estimate_usd: 100, multiplier: 4, serial_bucket: "first", label: "big serial" }} />
    )
    const title = withMult.container.querySelector("span")!.getAttribute("title")!
    expect(title).toContain("big serial")
    expect(title).toContain("4× the edition FMV")
    expect(title).toContain("Estimate, not a quote.")
    cleanup()

    const noMult = render(
      <SerialFmvBadge data={{ estimate_usd: 100, multiplier: NaN, serial_bucket: "first" }} />
    )
    expect(noMult.container.querySelector("span")!.getAttribute("title")).not.toContain("× the edition FMV")
  })
})
