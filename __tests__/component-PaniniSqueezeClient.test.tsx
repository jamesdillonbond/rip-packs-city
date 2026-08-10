// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

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
import PaniniSqueezeClient, { type Totals, type Coverage } from "@/app/insights/panini-squeeze/PaniniSqueezeClient"

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
  fmv_confidence: "HIGH",
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

// ASK-DERIVED FMV DISCLOSURE (2026-08-01). 727 editions on this board are priced
// at 0.90 x a single seller's ask on a card that has NEVER traded — including,
// before this shipped, the board's own top row ("Messi /1 — FMV $450,009", 90% of
// one $500,010 ask). Rendering that in the same typeface as a sale-derived price
// is the overclaim these pins exist to prevent, and it fails SILENTLY: drop the
// marker and the board still looks perfect.
//
// Both directions are pinned, because either regression is a product bug — losing
// the marker restores the overclaim, and marking every row drowns the signal.
describe("PaniniSqueezeClient — ask-derived FMV disclosure", () => {
  it("marks ONLY the ask-derived rows, and never prints the confidence enum", () => {
    const { container } = renderBoard(TOTALS, [
      row({ player_name: "Messi", fmv_usd: 450009, fmv_confidence: "ASK_ONLY" }),
      row({ player_name: "Traded", fmv_usd: 900, fmv_confidence: "HIGH" }),
      row({ player_name: "Unknown", fmv_usd: 700, fmv_confidence: null }),
    ])

    const markers = [...container.querySelectorAll("tbody .psq-basis")]
    expect(markers).toHaveLength(1)
    expect(markers[0].textContent).toBe("from asks")

    // ANTI-FALSEHOOD: the internal tier vocabulary must never reach the DOM.
    const text = container.textContent ?? ""
    for (const banned of ["ASK_ONLY", "HIGH", "MEDIUM", "STALE"]) {
      expect(text, banned).not.toContain(banned)
    }
  })

  it("headlines how much of the board is ask-derived, measured rather than hardcoded", () => {
    const { container } = renderBoard(TOTALS, [
      row({ player_name: "Messi", fmv_confidence: "ASK_ONLY" }),
      row({ player_name: "Mbappe", fmv_confidence: "ASK_ONLY" }),
      row({ player_name: "Traded", fmv_confidence: "HIGH" }),
    ])
    const notes = [...container.querySelectorAll(".psq-note")].map((n) => n.textContent ?? "").join(" ")
    expect(notes).toContain("2")
    expect(notes).toContain("never traded")
  })

  it("omits the disclosure entirely when nothing on the board is ask-derived", () => {
    const { container } = renderBoard(TOTALS, [row({ fmv_confidence: "HIGH" })])
    const notes = [...container.querySelectorAll(".psq-note")].map((n) => n.textContent ?? "").join(" ")
    expect(notes).not.toContain("never traded")
    expect(container.querySelectorAll("tbody .psq-basis")).toHaveLength(0)
  })
})

// The sort header (th onClick) and the four filter controls (mint-cap segments,
// Rookies toggle, player/parallel search) drive the `rows` useMemo — every branch
// of which was dark: the string vs numeric sort arms, the asc toggle, the cap
// predicate, the rookie predicate, and the query predicate.
describe("PaniniSqueezeClient — sort + filter controls", () => {
  const many = [
    row({ player_name: "Alpha", fmv_usd: 900, mint_cap: 25, is_rookie: true }),
    row({ player_name: "Bravo", fmv_usd: 100, mint_cap: 10, is_rookie: false }),
    row({ player_name: "Charlie", fmv_usd: 500, mint_cap: 1, is_rookie: true }),
  ]
  const bodyPlayers = (c: HTMLElement) =>
    [...c.querySelectorAll("tbody .psq-nm")].map((n) => n.textContent)
  const th = (c: HTMLElement, label: string) =>
    [...c.querySelectorAll("thead th")].find((h) => (h.textContent ?? "").startsWith(label)) as HTMLElement

  it("defaults to FMV descending", () => {
    const { container } = renderBoard(null, many)
    expect(bodyPlayers(container)).toEqual(["Alpha", "Charlie", "Bravo"]) // 900, 500, 100
  })

  it("toggles to ascending when the active FMV header is clicked again", () => {
    const { container } = renderBoard(null, many)
    fireEvent.click(th(container, "FMV"))
    expect(bodyPlayers(container)).toEqual(["Bravo", "Charlie", "Alpha"]) // 100, 500, 900
  })

  it("sorts alphabetically (string arm) when a text column header is clicked", () => {
    const { container } = renderBoard(null, many)
    fireEvent.click(th(container, "Player")) // new key → asc=false → reverse alpha
    expect(bodyPlayers(container)).toEqual(["Charlie", "Bravo", "Alpha"])
  })

  it("filters to 1-of-1s via the mint-cap segment", () => {
    const { container } = renderBoard(null, many)
    fireEvent.click([...container.querySelectorAll(".psq-seg button")].find((b) => b.textContent === "1-of-1s")!)
    expect(bodyPlayers(container)).toEqual(["Charlie"]) // only mint_cap === 1
  })

  it("filters by a mint-cap ceiling (≤ /10 keeps caps at or under 10)", () => {
    const { container } = renderBoard(null, many)
    fireEvent.click([...container.querySelectorAll(".psq-seg button")].find((b) => b.textContent === "≤ /10")!)
    // Alpha(25) drops; Bravo(10) + Charlie(1) remain, still FMV-desc.
    expect(bodyPlayers(container)).toEqual(["Charlie", "Bravo"])
  })

  it("filters to rookies via the Rookies toggle", () => {
    const { container } = renderBoard(null, many)
    fireEvent.click([...container.querySelectorAll(".psq-seg button")].find((b) => b.textContent === "Rookies")!)
    expect(bodyPlayers(container)).toEqual(["Alpha", "Charlie"]) // Bravo is_rookie false
  })

  it("narrows the board with the player/parallel search input", () => {
    const { container } = renderBoard(null, many)
    fireEvent.change(container.querySelector(".psq-controls input")!, { target: { value: "brav" } })
    expect(bodyPlayers(container)).toEqual(["Bravo"])
  })

  it("reports the slice when matches exceed the render cap", () => {
    const big = Array.from({ length: 305 }, (_, i) => row({ player_name: `P${i}`, fmv_usd: 1000 - i }))
    const { container } = renderBoard(null, big)
    expect(container.querySelectorAll("tbody tr")).toHaveLength(300) // RENDER_CAP
    const notes = [...container.querySelectorAll(".psq-note")].map((n) => n.textContent ?? "").join(" ")
    expect(notes).toMatch(/Showing\s+300\s+of\s+305\s+matching editions/i)
  })
})

// The coverage banner is a chain of conditional clauses, each of which is a live
// disclosure obligation (listing-gated basis, per-parallel range, still-discovering
// players, rotation-age). Every clause was dark — renderBoard passes coverage=null.
describe("PaniniSqueezeClient — coverage banner", () => {
  const COVERAGE: Coverage = {
    total_editions: 4149,
    trustworthy_editions: 1611,
    pct_trustworthy: 38.8,
    listing_gated_editions: 620,
    listing_gated_families: 12,
    families: 56,
    best_family_checklist_pct: 87,
    worst_family_checklist_pct: 7,
    checklist_players_seen: 487,
    checklist_players_new_24h: 5,
    oldest_family_refresh_h: 384, // >= 48 → rotation-age clause fires
    newest_family_refresh_h: 3,
  }

  it("renders the full disclosure chain when every field is populated", () => {
    const { container } = render(
      <PaniniSqueezeClient initialRows={[row()]} totals={TOTALS} coverage={COVERAGE} fetchedAt="2026-08-02T00:00:00Z" />,
    )
    const cov = container.querySelector(".psq-cov")?.textContent ?? ""
    expect(cov).toMatch(/RPC indexes/i)
    expect(cov).toMatch(/listed for sale/i)
    expect(cov).toMatch(/87%[\s\S]*down to[\s\S]*7%/i) // best/worst per-parallel range
    expect(cov).toMatch(/12/) // listing_gated_families of families
    expect(cov).toMatch(/new in the last 24h/i)
    expect(cov).toMatch(/16 days/i) // oldest 384h rounded to 16 days
    expect(cov).toMatch(/floor, not a census/i)
  })

  it("uses the fallback range copy when per-parallel percentages are absent", () => {
    const { container } = render(
      <PaniniSqueezeClient
        initialRows={[row()]}
        totals={TOTALS}
        coverage={{ ...COVERAGE, best_family_checklist_pct: null, worst_family_checklist_pct: null,
          listing_gated_editions: 0, checklist_players_new_24h: 0, oldest_family_refresh_h: 3 }}
        fetchedAt="2026-08-02T00:00:00Z"
      />,
    )
    const cov = container.querySelector(".psq-cov")?.textContent ?? ""
    expect(cov).toMatch(/thinnest exactly where cards are scarcest/i)
    expect(cov).not.toMatch(/new in the last 24h/i) // 0 new → clause omitted
    expect(cov).not.toMatch(/refreshed in rotation/i) // oldest < 48h → clause omitted
  })

  it("omits the banner entirely when the set has zero indexed editions", () => {
    const { container } = render(
      <PaniniSqueezeClient
        initialRows={[row()]}
        totals={TOTALS}
        coverage={{ ...COVERAGE, total_editions: 0 }}
        fetchedAt="2026-08-02T00:00:00Z"
      />,
    )
    expect(container.querySelector(".psq-cov")).toBeNull()
  })
})
