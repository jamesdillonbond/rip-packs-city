// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PinnacleListingCard from "@/components/pinnacle/PinnacleListingCard"

// Pure props->render Pinnacle listing card. Pins the money display (floor price
// $X.XX vs —), the serialized-only serial line, the locked flag, the variant/
// edition-type color fallback, and the outbound Buy link.

afterEach(cleanup)

const base = {
  editionKey: "e1",
  setName: "Mickey & Friends",
  characters: "Mickey Mouse",
  variant: "Golden",
  editionType: "Limited Edition",
  seriesName: "Series 1",
  franchise: "Disney",
  floorPrice: 42.5,
  serial: 7,
  isSerialized: true,
  isChaser: false,
  isLocked: false,
}

describe("PinnacleListingCard", () => {
  it("formats a numeric floor price as $X.XX", () => {
    const { container } = render(<PinnacleListingCard {...base} />)
    expect(container.textContent).toContain("$42.50")
  })

  it("shows an em-dash when floorPrice is null", () => {
    const { container } = render(<PinnacleListingCard {...base} floorPrice={null} />)
    expect(container.textContent).toContain("—")
    expect(container.textContent).not.toContain("$")
  })

  it("renders the serial line only for a serialized edition with a serial", () => {
    const { container: withSerial } = render(<PinnacleListingCard {...base} />)
    expect(withSerial.textContent).toContain("Serial #7")
    cleanup()
    const { container: noSerial } = render(<PinnacleListingCard {...base} isSerialized={false} />)
    expect(noSerial.textContent).not.toContain("Serial #")
    cleanup()
    const { container: nullSerial } = render(<PinnacleListingCard {...base} serial={null} />)
    expect(nullSerial.textContent).not.toContain("Serial #")
  })

  it("shows a LOCKED flag only when isLocked", () => {
    const { container: locked } = render(<PinnacleListingCard {...base} isLocked />)
    expect(locked.textContent).toContain("LOCKED")
    cleanup()
    const { container: unlocked } = render(<PinnacleListingCard {...base} />)
    expect(unlocked.textContent).not.toContain("LOCKED")
  })

  it("falls back to Standard colors for an unknown variant (never throws)", () => {
    const { container } = render(<PinnacleListingCard {...base} variant="Nonexistent Variant" />)
    // renders the character + set without crashing
    expect(container.textContent).toContain("Mickey Mouse")
  })

  it("renders the character, set, franchise and an outbound Buy link", () => {
    const { container } = render(<PinnacleListingCard {...base} />)
    expect(container.textContent).toContain("Mickey Mouse")
    expect(container.textContent).toContain("Mickey & Friends")
    expect(container.textContent).toContain("Disney")
    const buy = container.querySelector("a")
    expect(buy?.getAttribute("href")).toContain("disneypinnacle.com")
    expect(buy?.textContent).toBe("Buy")
  })
})
