// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The Panini squeeze board publishes ONE sealed-dollar headline, and as of
// 2026-07-28 three-fifths of the blended figure ($992,165 of $1,636,380) comes
// from sets whose discovery is listing-biased — the same survivor-bias shape as
// the 2026-07-16 chase-biased pack pools. The ruling was: lead with the honest
// subset ($644,215 / 2,144 editions), show the blend as a labelled secondary.
//
// That decision lives entirely in JSX, so nothing but a render test can hold it.
// The failure mode this pins is SILENT: swap `_hc` back to the blended field and
// the board still renders perfectly, just overstating sealed value by 2.5x.
//
// Two invariants matter most and are asserted as anti-falsehood pins:
//   1. the headline is the lower-bias number, and the blend is present but NOT
//      presented as the headline;
//   2. when the `_hc` columns are absent (older view / degraded fetch) the board
//      falls back to the blend WITHOUT the "lower-bias" labelling — mislabelling
//      a blended number is worse than showing a blend.
import PaniniSqueezeClient, { type Totals } from "@/app/insights/panini-squeeze/PaniniSqueezeClient"

// Live values, 2026-07-28 (panini_squeeze_totals).
const TOTALS: Totals = {
  editions: 3764,
  sealed_fmv_exposure_usd: 1636380,
  chases_lte_25: 2142,
  sealed_copies: 37496,
  editions_hc: 2144,
  sealed_fmv_exposure_usd_hc: 644215,
  sealed_copies_hc: 35317,
  pct_sealed_usd_from_biased_sets: 60.6,
}

const row = (over: Record<string, unknown> = {}) => ({
  player_name: "Lamine Yamal",
  set_name: "Base Prizms Gold",
  tier: "LEGENDARY",
  mint_cap: 10,
  pulled_count: 8,
  still_in_packs: 2,
  rip_pct: 80,
  fmv_usd: 900,
  sealed_fmv_exposure_usd: 1800,
  serial_low_ask_usd: 1100,
  is_rookie: true,
  is_debut: false,
  serials_with_recorded_price: 3,
  coverage_flag: "broad",
  ...over,
})

const renderBoard = (totals: Totals | null, rows: any[] = [row()]) =>
  render(
    <PaniniSqueezeClient initialRows={rows} totals={totals} coverage={null} fetchedAt="2026-07-28T12:00:00.000Z" />
  )

afterEach(cleanup)

describe("PaniniSqueezeClient — the honest headline", () => {
  it("leads with the lower-bias sealed value, not the blend", () => {
    const { container } = renderBoard(TOTALS)
    const bigs = [...container.querySelectorAll(".psq-big")].map((n) => n.textContent)

    // The hero figure is the lower-bias subset.
    expect(bigs).toContain("$644,215")
    // ANTI-FALSEHOOD: the blend must never be a hero figure.
    expect(bigs).not.toContain("$1,636,380")

    // Editions + sealed copies headline the same subset.
    expect(bigs).toContain("2,144")
    expect(bigs).not.toContain("3,764")
    expect(bigs).toContain("35,317")
  })

  it("still shows the blend, as a clearly-secondary labelled figure", () => {
    const { container } = renderBoard(TOTALS)
    const alt = [...container.querySelectorAll(".psq-alt")].map((n) => n.textContent).join(" | ")

    // Present — the honest split reports both populations, it does not hide one.
    expect(alt).toContain("$1,636,380")
    expect(alt).toMatch(/incl\. high-bias sets/i)
    expect(alt).toContain("3,764")
    expect(alt).toContain("37,496")
  })

  it("labels the headline cards as the lower-bias subset", () => {
    const { container } = renderBoard(TOTALS)
    const heads = [...container.querySelectorAll(".psq-card h3")].map((n) => n.textContent)
    expect(heads.filter((h) => /lower-bias/i.test(h || ""))).toHaveLength(3)
    // Chases has no _hc variant, so it must NOT claim to be the lower-bias subset.
    expect(heads.find((h) => /chases/i.test(h || ""))).toMatch(/all sets/i)
  })

  it("states the basis, quoting the biased share, and does not call the band 'coverage'", () => {
    const { container } = renderBoard(TOTALS)
    const notes = [...container.querySelectorAll(".psq-note")].map((n) => n.textContent).join(" | ")

    expect(notes).toContain("60.6%")
    expect(notes).toMatch(/listing-biased/i)
    // The band is derived from for_sale_count / pulled_count. Calling it "coverage"
    // on the surface would overclaim — it knows nothing about cards never seen.
    expect(notes).toMatch(/bias-risk indicator/i)
    expect(notes).toMatch(/not a measurement of how much of the checklist/i)
  })

  it("does not claim the totals cover every indexed edition once the split is live", () => {
    const { container } = renderBoard(TOTALS)
    const notes = [...container.querySelectorAll(".psq-note")].map((n) => n.textContent).join(" | ")
    // The pre-split copy read "Filters and the totals above run across all N indexed
    // editions" — false the moment the KPIs became a subset.
    expect(notes).not.toMatch(/totals above run across all/i)
    expect(notes).toMatch(/headline\s+totals above cover the/i)
  })
})

describe("PaniniSqueezeClient — fail-soft", () => {
  it("falls back to the blend WITHOUT lower-bias labelling when _hc is absent", () => {
    const blendOnly = {
      ...TOTALS,
      editions_hc: null,
      sealed_fmv_exposure_usd_hc: null,
      sealed_copies_hc: null,
      pct_sealed_usd_from_biased_sets: null,
    } as Totals
    const { container } = renderBoard(blendOnly)

    const bigs = [...container.querySelectorAll(".psq-big")].map((n) => n.textContent)
    expect(bigs).toContain("$1,636,380") // the blend is shown rather than nothing
    const heads = [...container.querySelectorAll(".psq-card h3")].map((n) => n.textContent).join(" | ")
    expect(heads).not.toMatch(/lower-bias/i) // ...but is never mislabelled as the subset
  })

  it("renders from slice-derived totals when the totals query failed entirely", () => {
    const { container } = renderBoard(null, [row(), row({ player_name: "Jude Bellingham" })])
    const bigs = [...container.querySelectorAll(".psq-big")].map((n) => n.textContent)
    expect(bigs).toContain("2") // editions, from initialRows.length
    expect(bigs).toContain("$3,600") // 2 x sealed_fmv_exposure_usd
    const heads = [...container.querySelectorAll(".psq-card h3")].map((n) => n.textContent).join(" | ")
    expect(heads).not.toMatch(/lower-bias/i)
  })
})

describe("PaniniSqueezeClient — per-row bias band", () => {
  it("badges each row with its band and keeps the header/cell counts aligned", () => {
    const { container } = renderBoard(TOTALS, [
      row({ coverage_flag: "broad" }),
      row({ player_name: "A", coverage_flag: "heavily_biased" }),
      row({ player_name: "B", coverage_flag: "listing_gated" }),
      row({ player_name: "C", coverage_flag: "partial" }),
      row({ player_name: "D", coverage_flag: null }),
    ])

    const bands = [...container.querySelectorAll(".psq-band")].map((n) => n.textContent?.trim())
    expect(bands).toEqual(["Broad", "High bias", "Listed only", "Partial"]) // null row renders "—", not a band

    const headers = container.querySelectorAll("thead th")
    const firstRowCells = container.querySelectorAll("tbody tr:first-child td")
    expect(firstRowCells.length).toBe(headers.length)
  })

  it("uses the empty-state colSpan that matches the header count", () => {
    const { container } = renderBoard(TOTALS, [])
    const headers = container.querySelectorAll("thead th").length
    expect(container.querySelector("tbody td")?.getAttribute("colSpan")).toBe(String(headers))
  })
})
