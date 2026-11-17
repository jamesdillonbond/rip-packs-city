// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// TeamLogo — measured at 0% statements before this file. It is the client island
// that exists SOLELY for its failure path: TeamHero is a server component, and
// this was split out only because the `onError` fallback needs client JS.
//
// So the untested branch was the entire reason the component exists. A broken
// logo URL with no fallback leaves a blank 96px hole in the hero of every team
// page — and the CDN going stale for one franchise is exactly the case it was
// written for.

import TeamLogo from "@/components/entity/TeamLogo"

afterEach(cleanup)

describe("TeamLogo — renders the logo when it loads", () => {
  it("renders the image, not the initials badge", () => {
    const { container } = render(
      <TeamLogo logoUrl="https://cdn.example/blazers.png" abbreviation="POR" secondaryColor="#111" />,
    )
    const img = container.querySelector("img")
    expect(img?.getAttribute("src")).toBe("https://cdn.example/blazers.png")
    // The logo is decorative beside a named heading, so its alt must stay EMPTY
    // rather than repeating the team name to a screen reader.
    expect(img?.getAttribute("alt")).toBe("")
    expect(container.textContent).toBe("")
  })
})

describe("TeamLogo — falls back to initials (the reason this file is a client island)", () => {
  it("swaps to the initials badge when the image errors", () => {
    const { container } = render(
      <TeamLogo logoUrl="https://cdn.example/gone.png" abbreviation="POR" secondaryColor="#111" />,
    )
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("POR")
  })

  it("renders the initials badge immediately when there is no logo URL", () => {
    const { container } = render(<TeamLogo logoUrl={null} abbreviation="por" secondaryColor="#111" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("POR")
  })

  it("caps initials at three characters and uppercases them", () => {
    const { container } = render(
      <TeamLogo logoUrl={null} abbreviation="Trail Blazers" secondaryColor={null} />,
    )
    // Not cosmetic: the badge is a fixed 96px box, so an uncapped abbreviation
    // overflows the hero rather than wrapping.
    expect(container.textContent).toBe("TRA")
  })

  it("renders a placeholder rather than nothing when the abbreviation is missing too", () => {
    // Both inputs absent is a real state (a team row with no logo and no abbr).
    // An empty box reads as a layout bug; "?" reads as missing data.
    const { container } = render(<TeamLogo logoUrl={null} abbreviation={null} secondaryColor={null} />)
    expect(container.textContent).toBe("?")
    // Decorative, so it must stay out of the accessibility tree entirely.
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull()
  })

  it("uses the team's secondary colour for the badge border, not a fixed one", () => {
    // ⚠ jsdom normalizes a hex literal to `rgb()`, so asserting on "#E03A2F"
    // reds against a correct implementation. Assert the normalized form, and
    // pair it with the null case so this cannot pass on a hardcoded colour.
    const withColor = render(
      <TeamLogo logoUrl={null} abbreviation="POR" secondaryColor="#E03A2F" />,
    ).container.firstChild as HTMLElement
    expect(withColor.style.border).toContain("rgb(224, 58, 47)")

    cleanup()
    const withoutColor = render(<TeamLogo logoUrl={null} abbreviation="POR" secondaryColor={null} />)
      .container.firstChild as HTMLElement
    expect(withoutColor.style.border).not.toContain("rgb(224, 58, 47)")
  })
})
