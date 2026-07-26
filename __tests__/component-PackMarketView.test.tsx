// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// PackMarketView dispatches per collection: it picks the tier vocabulary, title,
// and model note for each of the 5 slugs and hands them to PackPageClient. A
// wrong tier list or slug here misconfigures the whole pack board, so we stub
// PackPageClient to a probe and assert the props each branch passes.

const seen: Record<string, unknown>[] = []
vi.mock("@/components/packs/PackPageClient", () => ({
  default: (props: Record<string, unknown>) => {
    seen.push(props)
    return <div data-testid="ppc" data-collection={String(props.collection)} data-title={String(props.title)} />
  },
}))

import PackMarketView from "@/components/packs/PackMarketView"

afterEach(() => {
  cleanup()
  seen.length = 0
})

function propsFor(collection: string) {
  render(<PackMarketView collection={collection} />)
  return seen[seen.length - 1]
}

describe("PackMarketView per-collection dispatch", () => {
  it("Top Shot: full TS tier ladder, no model note", () => {
    const { container } = render(<PackMarketView collection="nba-top-shot" />)
    const p = seen[seen.length - 1]
    expect(p.collection).toBe("nba-top-shot")
    expect(p.tiers).toEqual(["ultimate", "legendary", "rare", "fandom", "common"])
    expect(p.title).toContain("Pack Distributions")
    expect(container.querySelector('[role="note"]')).toBeNull() // TS has no ModelNote
  })

  it("Pinnacle: EMPTY tier list (variants, not tiers) + a supply-weighted model note", () => {
    const { container } = render(<PackMarketView collection="disney-pinnacle" />)
    const p = seen[seen.length - 1]
    expect(p.collection).toBe("disney-pinnacle")
    expect(p.tiers).toEqual([]) // no tier chips for Pinnacle
    expect(container.querySelector('[role="note"]')?.textContent).toContain("supply-weighted")
  })

  it("Golazos: pack-type descriptor tiers, premium-first", () => {
    const p = propsFor("laliga-golazos")
    expect(p.tiers).toEqual([
      "historic_premium",
      "in_season_premium",
      "historic_standard",
      "in_season_standard",
    ])
    expect(p.title).toContain("LaLiga Golazos")
  })

  it("All Day: 6-tier ladder + the 'ended primary pack sales' note", () => {
    const { container } = render(<PackMarketView collection="nfl-all-day" />)
    const p = seen[seen.length - 1]
    expect(p.tiers).toEqual(["ultimate", "legendary", "rare", "premium", "standard", "common"])
    expect(container.querySelector('[role="note"]')?.textContent).toContain("ended primary pack sales")
  })

  it("an unknown collection falls through to the Top Shot default", () => {
    const p = propsFor("mystery")
    expect(p.collection).toBe("nba-top-shot")
    expect(p.tiers).toEqual(["ultimate", "legendary", "rare", "fandom", "common"])
  })
})
