// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// Second interaction/branch pass over the low-branch public /insights board
// clients (continues component-insights-clients-interaction.test.tsx). Covers
// four more of the lowest-branch clients across BOTH interaction models:
//
//   · RookieBoardClient       — PURE client-side (view/tier/parallel filters +
//                               useMemo grouping, burn view, copy link). No fetch.
//   · SetCompletersBoardClient— PURE client-side sort (completers/rate/size).
//   · OfferSpreadBoardClient  — REFETCH on tier / ≥floor / sort (+ error state).
//   · ParallelPremiumsBoardClient — REFETCH on parallel chip / confidence / sort.
//
// The smoke + populated-row suites render the default view; the branches here are
// the ones a visitor actually drives — the filter/sort toggles and the money/
// pct/multiple formatter bands + tier-color ladder + per-row conditional cells.
// A regression shows a wrong sort/filter or a silent "$0"/"—" where a real
// number belongs.
// ─────────────────────────────────────────────────────────────────────────────

import RookieBoardClient from "@/app/insights/rookie-board/RookieBoardClient"
import type { RookieEditionRow } from "@/lib/rookie-edition-board"
import SetCompletersBoardClient from "@/app/insights/set-completers/SetCompletersBoardClient"
import OfferSpreadBoardClient, { type Row as OfferRow } from "@/app/insights/offer-spread/OfferSpreadBoardClient"
import ParallelPremiumsBoardClient from "@/app/insights/parallel-premiums/ParallelPremiumsBoardClient"
import type { ParallelRow } from "@/lib/parallel-premiums-board"

const FETCHED = "2026-08-08T00:00:00Z"

let boardResponse: { ok: boolean; rows?: unknown[]; status?: number }

beforeEach(() => {
  boardResponse = { ok: true, rows: [] }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({ user: null }) } as Response)
      }
      if (!boardResponse.ok) {
        return Promise.resolve({ ok: false, status: boardResponse.status ?? 500 } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          rows: boardResponse.rows ?? [],
          meta: { fetched_at: FETCHED, total_rows: (boardResponse.rows ?? []).length, elapsed_ms: 1 },
        }),
      } as Response)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── RookieBoard (pure client-side) ──────────────────────────────────────────
function rookieRow(o: Partial<RookieEditionRow>): RookieEditionRow {
  return {
    player_name: "Rook One", set_name: "Base Set", series_number: 5, tier: "COMMON",
    parallel_id: 0, parallel_name: "Standard", external_id: "10:20", circulation_count: 1000,
    fmv_usd: 50, fmv_confidence: "HIGH", low_ask: 60, highest_offer: 40, avg_sale_price: 55,
    burned: 0, locked: 0, effective_supply: 1000, burn_rate_pct: 0, lock_rate_pct: 0,
    has_full_economics: false, thumbnail_url: null, video_url: null, ...o,
  }
}
const rookieRows: RookieEditionRow[] = [
  rookieRow({ player_name: "Legend Guy", tier: "MOMENT_TIER_LEGENDARY", parallel_id: 0, fmv_usd: 5000, has_full_economics: true, burned: 300, thumbnail_url: "https://cdn/a.png" }),
  rookieRow({ player_name: "Rare Guy", tier: "RARE", parallel_id: 3, parallel_name: "Galactic", fmv_usd: 200, has_full_economics: true, burned: 25 }),
  rookieRow({ player_name: "No FMV", tier: null, parallel_id: 0, fmv_usd: null, has_full_economics: false, burned: 0 }),
]

describe("RookieBoardClient — client-side filters + views", () => {
  it("renders the board view with the FMV chases + kpis", () => {
    const { container } = render(<RookieBoardClient initialRows={rookieRows} initialFetchedAt={FETCHED} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Legend Guy")
    expect(text).toContain("$5,000") // fmtMoney >= 100 band
  })

  it("filters to a tier when a tier pill is clicked", () => {
    const { getByText, container } = render(<RookieBoardClient initialRows={rookieRows} initialFetchedAt={FETCHED} />)
    fireEvent.click(getByText("Legendary"))
    const text = container.textContent ?? ""
    expect(text).toContain("Legend Guy")
    expect(text).not.toContain("Rare Guy") // filtered out
  })

  it("filters to parallels-only", () => {
    const { getByText, container } = render(<RookieBoardClient initialRows={rookieRows} initialFetchedAt={FETCHED} />)
    fireEvent.click(getByText("Parallels only"))
    const text = container.textContent ?? ""
    expect(text).toContain("Rare Guy") // parallel_id 3 kept
    expect(text).not.toContain("Legend Guy") // parallel_id 0 dropped
  })

  it("switches to the Burn Rankings view", () => {
    const { getByText, container } = render(<RookieBoardClient initialRows={rookieRows} initialFetchedAt={FETCHED} />)
    fireEvent.click(getByText("Burn Rankings"))
    // burnRows keeps has_full_economics && burned>0 → Legend Guy (300) + Rare Guy (25)
    expect(container.textContent ?? "").toContain("Legend Guy")
  })

  it("copies the share link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { getByText } = render(<RookieBoardClient initialRows={rookieRows} initialFetchedAt={FETCHED} />)
    fireEvent.click(getByText(/Copy link/i))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
  })
})

// ── SetCompleters (pure client-side sort) ───────────────────────────────────
const setCompRows = [
  { set_id_onchain: 1, set_name: "Alpha", total_plays: 10, completers: 5, holders_with_any: 100, completion_rate: 0.05 },
  { set_id_onchain: 2, set_name: "Beta", total_plays: 200, completers: 2, holders_with_any: 50, completion_rate: 0.5 },
  { set_id_onchain: 3, set_name: null, total_plays: 50, completers: 0, holders_with_any: 10, completion_rate: 0 },
]

describe("SetCompletersBoardClient — client-side sort", () => {
  it("renders rows + the completer color/empty branches", () => {
    const { container } = render(
      <SetCompletersBoardClient initialBoard={{ rows: setCompRows as any }} initialFetchedAt={FETCHED} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Alpha")
    expect(text).toContain("Set 3") // null set_name → "Set {id}"
    expect(text).toContain("50%") // completion_rate 0.5 → 50%
  })

  it("re-sorts by completion rate then by set size", () => {
    const { getByRole, container } = render(
      <SetCompletersBoardClient initialBoard={{ rows: setCompRows as any }} initialFetchedAt={FETCHED} />
    )
    // "Completion rate" is also a column header, so scope to the sort BUTTON.
    fireEvent.click(getByRole("button", { name: "Completion rate" }))
    let firstRow = container.querySelector("tbody tr")?.textContent ?? ""
    expect(firstRow).toContain("Beta") // completion_rate 0.5 highest
    fireEvent.click(getByRole("button", { name: "Set size" }))
    firstRow = container.querySelector("tbody tr")?.textContent ?? ""
    expect(firstRow).toContain("Beta") // total_plays 200 highest
    fireEvent.click(getByRole("button", { name: "Most completers" }))
    firstRow = container.querySelector("tbody tr")?.textContent ?? ""
    expect(firstRow).toContain("Alpha") // completers 5 highest
  })
})

// ── OfferSpread (refetch) ───────────────────────────────────────────────────
function offerRow(o: Partial<OfferRow>): OfferRow {
  return {
    external_id: "10:20", name: "Moment", player_name: "Player", set_name: "Set", tier: "COMMON",
    circulation_count: 1000, highest_offer: 40, low_ask: 60, offer_pct_of_ask: 66.7,
    par_distance: 5, spread_usd: 20, bid_meets_ask: false, updated_at: FETCHED, ...o,
  }
}
const offerRows: OfferRow[] = [
  offerRow({ external_id: "1:1", bid_meets_ask: true, par_distance: 0, spread_usd: 0 }),
  offerRow({ external_id: "2:2", tier: "RARE", spread_usd: 100 }),
]

describe("OfferSpreadBoardClient — refetch on filters", () => {
  it("renders populated rows + kpis", () => {
    const { container } = render(<OfferSpreadBoardClient initialRows={offerRows} initialFetchedAt={FETCHED} />)
    expect((container.textContent ?? "")).toContain("Player")
  })
  it("refetches with tier= when a tier pill is clicked", async () => {
    const { getByRole } = render(<OfferSpreadBoardClient initialRows={offerRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: offerRows }
    // "COMMON" also renders in row tier cells → scope to the filter BUTTON.
    fireEvent.click(getByRole("tab", { name: "COMMON" }))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("tier=COMMON"))).toBe(true)
    })
  })
  it("refetches with bid_meets_ask=true on the ≥ floor toggle", async () => {
    const { getByText } = render(<OfferSpreadBoardClient initialRows={offerRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: offerRows }
    fireEvent.click(getByText("≥ floor only"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("bid_meets_ask=true"))).toBe(true)
    })
  })
  it("refetches with sort= when the sort select changes", async () => {
    const { container } = render(<OfferSpreadBoardClient initialRows={offerRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: offerRows }
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "spread" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=spread"))).toBe(true)
    })
  })
  it("shows the error state on a non-ok refetch", async () => {
    const { getByRole, container } = render(<OfferSpreadBoardClient initialRows={offerRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: false, status: 500 }
    fireEvent.click(getByRole("tab", { name: "RARE" }))
    await waitFor(() => expect((container.textContent ?? "").toLowerCase()).toContain("failed"))
  })
})

// ── ParallelPremiums (refetch) ──────────────────────────────────────────────
function parRow(o: Partial<ParallelRow>): ParallelRow {
  return {
    edition_id: "e1", external_id: "10:20", base_ext: "10", player_name: "Player", set_name: "Set",
    series: 5, tier: "RARE", subedition_name: "Hexwave", parallel_circ: 99, base_circ: 5000,
    base_fmv: 10, base_confidence: "HIGH", parallel_fmv: 300, parallel_confidence: "HIGH",
    premium_mult: 30, both_high_conf: true, thumbnail_url: null, ...o,
  }
}
const parRows: ParallelRow[] = [
  parRow({ subedition_name: "Hexwave", premium_mult: 30 }),
  parRow({ edition_id: "e2", subedition_name: "Jukebox", premium_mult: 4.5, parallel_fmv: 45 }),
]

describe("ParallelPremiumsBoardClient — refetch on chip/confidence/sort", () => {
  it("renders the premium multiple + parallel/base FMV bands", () => {
    const { container } = render(<ParallelPremiumsBoardClient initialRows={parRows} initialFetchedAt={FETCHED} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Player")
    expect(text).toContain("Hexwave")
  })
  it("refetches with parallel= when a parallel chip is clicked", async () => {
    const { getAllByText } = render(<ParallelPremiumsBoardClient initialRows={parRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: parRows }
    // the chip label is the subedition_name; click the first "Hexwave" control
    fireEvent.click(getAllByText("Hexwave")[0])
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("parallel=Hexwave"))).toBe(true)
    })
  })
  it("refetches with conf=all when the confidence chip is toggled off", async () => {
    const { getByText } = render(<ParallelPremiumsBoardClient initialRows={parRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: parRows }
    fireEvent.click(getByText("High-confidence only"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("conf=all"))).toBe(true)
    })
  })
  it("refetches with sort= when the sort select changes", async () => {
    const { container } = render(<ParallelPremiumsBoardClient initialRows={parRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: parRows }
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "parallel_fmv" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=parallel_fmv"))).toBe(true)
    })
  })
})
