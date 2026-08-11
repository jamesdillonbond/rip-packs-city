// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

// next/image renders an <img> in jsdom but wants width/height; stub it to a
// plain img so the grid render doesn't warn/throw on the fixture art.
vi.mock("next/image", () => ({ default: (props: any) => {
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return null
} }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

import EditionGrid, { formatUsd, formatCirculation } from "@/components/analytics/EditionGrid"
import type { SetsDetailEdition } from "@/lib/analytics-types"

// Pins the Sets EditionGrid's money + circulation formatters — the ones that
// decide what a collector reads on each edition card. formatUsd MUST say
// "No FMV" for a null price (not "$0.00", which reads as a real free edition),
// and formatCirculation MUST say "—" for null/0 (not "0", which reads as a
// zero-supply edition). Bands are pinned so a $M/$k rollover never mis-scales.

afterEach(cleanup)

describe("EditionGrid.formatUsd", () => {
  it("says 'No FMV' for null/undefined/non-finite (never a fake $0.00)", () => {
    expect(formatUsd(null)).toBe("No FMV")
    expect(formatUsd(undefined)).toBe("No FMV")
    expect(formatUsd(Number.NaN)).toBe("No FMV")
  })
  it("bands $M / $k and shows cents below $1k", () => {
    expect(formatUsd(2_500_000)).toBe("$2.50M")
    expect(formatUsd(2500)).toBe("$2.5k")
    expect(formatUsd(5)).toBe("$5.00")
    expect(formatUsd(0.5)).toBe("$0.50")
  })
})

describe("EditionGrid.formatCirculation", () => {
  it("says — for null / 0 / negative (never a fake 0-supply)", () => {
    expect(formatCirculation(null)).toBe("—")
    expect(formatCirculation(0)).toBe("—")
    expect(formatCirculation(-3)).toBe("—")
  })
  it("bands M / k and shows the raw count below 1k", () => {
    expect(formatCirculation(2_500_000)).toBe("2.50M")
    expect(formatCirculation(2500)).toBe("2.5k")
    expect(formatCirculation(99)).toBe("99")
  })
})

const ed = (over: Partial<SetsDetailEdition> = {}): SetsDetailEdition => ({
  edition_id: "e1",
  edition_external_id: "1:1",
  name: "LeBron James",
  tier: "Legendary",
  circulation_count: 2500,
  series: 4,
  play_type: "Dunk",
  thumbnail_url: null,
  first_minted_at: "2026-01-01",
  fmv_usd: 1500,
  fmv_confidence: "HIGH",
  ...over,
})

describe("EditionGrid render", () => {
  it("renders edition cards with the formatted FMV + circulation", () => {
    render(<EditionGrid editions={[ed({})]} collection="topshot" />)
    expect(screen.getAllByText("LeBron James").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("$1.5k")).toBeTruthy() // fmv 1500
    expect(screen.getByText("2.5k")).toBeTruthy() // circulation
  })

  it("shows 'No FMV' on an unpriced edition rather than a fake $0", () => {
    render(<EditionGrid editions={[ed({ edition_id: "e2", name: "Rookie X", fmv_usd: null, fmv_confidence: null })]} collection="topshot" />)
    expect(screen.getByText("No FMV")).toBeTruthy()
  })
})

// ── Interaction + card-branch coverage ─────────────────────────────────────
// The formatter + basic-render suite above leaves the empty state, the FMV/Name
// sort toggle, the linkable-vs-static card wrapper, and the per-card conditional
// chips (tier pill / play-type / thumbnail / confidence / placeholder art) dark.
import { fireEvent } from "@testing-library/react"

describe("EditionGrid — empty + interaction", () => {
  it("renders the empty state when the set has no editions", () => {
    render(<EditionGrid editions={[]} collection="topshot" />)
    expect(screen.getByText(/no editions in our catalog yet/i)).toBeTruthy()
  })

  it("uses the singular 'edition' label for a set of one", () => {
    render(<EditionGrid editions={[ed({})]} collection="topshot" />)
    expect(screen.getByText(/1 edition in this set/i)).toBeTruthy()
  })

  it("re-sorts by name when the Name toggle is clicked, then back on FMV", () => {
    const editions = [
      ed({ edition_id: "z1", name: "Zeb Zorro", fmv_usd: 5000 }),
      ed({ edition_id: "a1", name: "Aaron Ace", fmv_usd: 10 }),
    ]
    const { container } = render(<EditionGrid editions={editions} collection="topshot" />)
    const names = () => Array.from(container.querySelectorAll(".line-clamp-2")).map((n) => n.textContent)
    // Default fmv_desc → higher FMV (Zeb, 5000) first.
    expect(names()[0]).toContain("Zeb Zorro")
    fireEvent.click(screen.getByRole("button", { name: "Name" }))
    // name_asc → Aaron before Zeb.
    expect(names()[0]).toContain("Aaron Ace")
    fireEvent.click(screen.getByRole("button", { name: "FMV" }))
    expect(names()[0]).toContain("Zeb Zorro")
  })
})

describe("EditionGrid — card branch rendering", () => {
  it("links a UUID edition on a linkable collection to /edition/[id]", () => {
    const uuid = "11111111-2222-3333-4444-555555555555"
    const { container } = render(
      <EditionGrid editions={[ed({ edition_id: uuid })]} collection="golazos" />,
    )
    const link = container.querySelector(`a[href="/edition/${uuid}"]`)
    expect(link).toBeTruthy()
  })

  it("does NOT link when the collection is not linkable (e.g. ufc)", () => {
    const uuid = "11111111-2222-3333-4444-555555555555"
    const { container } = render(
      <EditionGrid editions={[ed({ edition_id: uuid })]} collection="ufc" />,
    )
    expect(container.querySelector(`a[href="/edition/${uuid}"]`)).toBeNull()
  })

  it("does NOT link a non-UUID edition_id even on a linkable collection", () => {
    const { container } = render(
      <EditionGrid editions={[ed({ edition_id: "8:1234" })]} collection="topshot" />,
    )
    expect(container.querySelector('a[href^="/edition/"]')).toBeNull()
  })

  it("renders the play-type chip and a known tier pill", () => {
    const { container } = render(
      <EditionGrid editions={[ed({ tier: "Legendary", play_type: "Dunk" })]} collection="topshot" />,
    )
    expect(container.textContent).toContain("Dunk")
    expect(container.textContent).toContain("Legendary")
  })

  it("omits the tier pill for a tier not in the pill map, and omits play-type when null", () => {
    const { container } = render(
      <EditionGrid editions={[ed({ tier: "Mythic" as never, play_type: null })]} collection="topshot" />,
    )
    // 'Mythic' is not a TIER_PILL key -> no tier pill rendered.
    expect(container.textContent).not.toContain("Mythic")
    expect(container.textContent).not.toContain("Dunk")
  })

  it("renders the thumbnail image path when a thumbnail_url is present", () => {
    // next/image is mocked to null, but the branch (thumbnail vs placeholder)
    // still executes; the placeholder art must NOT render.
    const { container } = render(
      <EditionGrid
        editions={[ed({ name: "Arty", thumbnail_url: "https://cdn/art.png", fmv_usd: 12 })]}
        collection="topshot"
      />,
    )
    // PlaceholderArt renders the edition name inside a gradient tile when there
    // is no thumbnail; with a thumbnail present it is absent, but the card name
    // still shows once (the title line).
    expect(container.querySelector(".bg-gradient-to-br")).toBeNull()
  })

  it("falls back to Common gradient art and an em-dash for an unknown-tier, unnamed edition", () => {
    const { container } = render(
      <EditionGrid
        editions={[ed({ name: null as never, tier: "Nonsense" as never, thumbnail_url: null })]}
        collection="topshot"
      />,
    )
    const art = container.querySelector(".bg-gradient-to-br")
    expect(art).toBeTruthy()
    // Unknown tier -> Common gradient classes.
    expect(art?.className).toContain("zinc")
    // Null name inside PlaceholderArt renders the em-dash.
    expect(art?.textContent).toContain("—")
  })

  it("omits the confidence pill when fmv_confidence is null", () => {
    const { container } = render(
      <EditionGrid editions={[ed({ fmv_confidence: null })]} collection="topshot" />,
    )
    // None/High/Med etc. confidence labels are absent when confidence is null.
    expect(container.textContent).not.toMatch(/\b(High|Med|Low|Ask|Sales|Stale|None)\b/)
  })
})
