// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import type React from "react"
import { render, cleanup, fireEvent } from "@testing-library/react"
import CandyBoardClient from "@/app/insights/candy-mlb/CandyBoardClient"

// DataTable's row cap, and the null-ordering rule underneath it — the two places
// this public board can be wrong while every visible number stays correct.
//
// ⚠ WHY THE CAP NEEDED A STRUCTURAL FIX. `cap` is applied as `r.slice(0, cap)`
// AFTER sorting, so an overflow is invisible by construction: the board just
// stops, and nothing on screen is wrong. The file's own comments show the
// history — call sites were individually raised (550→800, 250→800) each time
// someone noticed, with the note "DataTable slices silently with no 'showing N
// of M' indicator". That is a data-dependent margin, not a guarantee: Candy is
// expecting further drops and the scarcity tab sits at cap 130 against 125
// editions. Disclosing it in DataTable makes a future overflow announce itself.
//
// The nulls rule is the quieter half. `x == null ? (asc ? Infinity : -Infinity)`
// pushes unpriced rows to the BOTTOM in BOTH directions. On a board whose whole
// job is ranking by price, letting nulls float to the top of an ascending sort
// would present "we have no price for this" as "this is the cheapest".

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Scarcity rows — the tab whose cap (130) is closest to its real row count. */
function scarcityRows(n: number, over: (i: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    external_id: `e${i}`,
    player_name: `Player ${String(i).padStart(4, "0")}`,
    is_rainbow: false,
    supply: 100 + i,
    holders: 10 + i,
    circulating_pct: 50 + (i % 40),
    fmv_usd: 10 + i,
    ...over(i),
  }))
}

// The real prop shape: flat props, `initialRows` for Market, `fetchedAt`.
// Widened to an index-signature component so a per-tab fixture can be spread in
// without restating the nine optional row arrays at every call site.
const Board = CandyBoardClient as unknown as (p: Record<string, unknown>) => React.ReactElement

function mount(payload: Record<string, unknown>) {
  return render(<Board initialRows={[]} fetchedAt="2026-08-02T00:00:00Z" {...payload} />)
}

/** Tab buttons carry a count badge ("Scarcity130"), so match on the PREFIX. */
function tab(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label)
  )
  if (!el) throw new Error(`tab "${label}" not found`)
  return el as HTMLElement
}

describe("a capped ranking says so", () => {
  it("discloses the cap when there are more rows than it shows", () => {
    // 200 > the scarcity cap of 130.
    const { container } = mount({ scarcity: scarcityRows(200) })
    fireEvent.click(tab(container, "Scarcity"))
    const note = container.querySelector(".cdy-trunc")
    expect(note, "an overflowing ranked table must disclose the cap").toBeTruthy()
    const t = note?.textContent ?? ""
    expect(t).toContain("130")
    expect(t).toContain("200")
    // The wording has to say the list is INCOMPLETE, not merely long.
    expect(t).toMatch(/capped, not complete/)
  })

  it("renders exactly the capped number of rows", () => {
    const { container } = mount({ scarcity: scarcityRows(200) })
    fireEvent.click(tab(container, "Scarcity"))
    // Header row is in <thead>, so count body rows only.
    expect(container.querySelectorAll("tbody tr").length).toBe(130)
  })

  it("says NOTHING when the data fits", () => {
    // The mirror. A permanent "this list is capped" note on a complete board
    // would be its own false claim, and would train the reader to ignore it.
    const { container } = mount({ scarcity: scarcityRows(20) })
    fireEvent.click(tab(container, "Scarcity"))
    expect(container.querySelector(".cdy-trunc")).toBeNull()
  })

  it("says nothing at exactly the cap — that board IS complete", () => {
    // Boundary: rows.length === cap is not truncation.
    const { container } = mount({ scarcity: scarcityRows(130) })
    fireEvent.click(tab(container, "Scarcity"))
    expect(container.querySelectorAll("tbody tr").length).toBe(130)
    expect(container.querySelector(".cdy-trunc")).toBeNull()
  })

  it("announces itself politely to assistive tech rather than silently", () => {
    const { container } = mount({ scarcity: scarcityRows(200) })
    fireEvent.click(tab(container, "Scarcity"))
    expect(container.querySelector(".cdy-trunc")?.getAttribute("role")).toBe("status")
  })
})

describe("unpriced rows sort to the BOTTOM in both directions", () => {
  const withNulls = () => [
    ...scarcityRows(3, (i) => ({ fmv_usd: [30, 10, 20][i], player_name: `Priced ${i}` })),
    ...scarcityRows(2, (i) => ({ fmv_usd: null, player_name: `Unpriced ${i}` })),
  ]

  it("keeps nulls last when sorting descending", () => {
    const { container } = mount({ scarcity: withNulls() })
    fireEvent.click(tab(container, "Scarcity"))
    const fmvHeader = Array.from(container.querySelectorAll("th")).find((h) =>
      /fmv/i.test(h.textContent ?? "")
    )
    expect(fmvHeader).toBeTruthy()
    fireEvent.click(fmvHeader as Element)
    const t = container.textContent ?? ""
    expect(t.indexOf("Priced")).toBeLessThan(t.indexOf("Unpriced"))
  })

  it("keeps nulls last when sorting ASCENDING too", () => {
    // The load-bearing case. A naive `null -> 0` or a stable-sort fallthrough
    // floats unpriced rows to the top of an ascending price sort, presenting
    // "we have no price" as "this is the cheapest" on a deals-oriented board.
    const { container } = mount({ scarcity: withNulls() })
    fireEvent.click(tab(container, "Scarcity"))
    const fmvHeader = Array.from(container.querySelectorAll("th")).find((h) =>
      /fmv/i.test(h.textContent ?? "")
    )
    fireEvent.click(fmvHeader as Element) // desc
    fireEvent.click(fmvHeader as Element) // asc
    const t = container.textContent ?? ""
    expect(t.indexOf("Priced")).toBeLessThan(t.indexOf("Unpriced"))
  })
})

describe("money formatting never invents a price", () => {
  it("renders an em-dash for a null, a NaN and a non-positive value", () => {
    // $0 is not a market price on a marketplace board — it is the absence of
    // one — so it must not render as "$0" beside real asks.
    const { container } = mount({
      scarcity: [
        ...scarcityRows(1, () => ({ fmv_usd: null, player_name: "NullPrice" })),
        ...scarcityRows(1, () => ({ fmv_usd: 0, player_name: "ZeroPrice" })),
        ...scarcityRows(1, () => ({ fmv_usd: Number.NaN, player_name: "NanPrice" })),
      ],
    })
    fireEvent.click(tab(container, "Scarcity"))
    const t = container.textContent ?? ""
    expect(t).not.toMatch(/\$NaN|\$0\b/)
    expect(t).toContain("—")
  })

  it("keeps cents under $100 and drops them at or above it", () => {
    const { container } = mount({
      scarcity: [
        ...scarcityRows(1, () => ({ fmv_usd: 12.345, player_name: "Small" })),
        ...scarcityRows(1, () => ({ fmv_usd: 1234.56, player_name: "Big" })),
      ],
    })
    fireEvent.click(tab(container, "Scarcity"))
    const t = container.textContent ?? ""
    expect(t).toContain("$12.35")
    expect(t).toContain("$1,235")
  })
})
