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
