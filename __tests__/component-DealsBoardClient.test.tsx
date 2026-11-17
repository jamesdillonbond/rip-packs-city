// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// DealsBoardClient is the public /insights/deals surface (~950 lines) — the
// cross-collection "listed below FMV" board across Top Shot / All Day / Pinnacle,
// with the fee-net-of-resale honesty column (a gross discount that fees erase is
// flagged). Previously ZERO render coverage and unmeasured (lives under app/).
// These tests drive its render loop + fmtUsd/fmtPct/median + the feeNetDeal
// annotation over populated + null rows, the empty state, and the sort re-fetch.

import DealsBoardClient, { type Row } from "@/app/insights/deals/DealsBoardClient"

const fullRow: Row = {
  external_id: "141:5156",
  name: "Victor Wembanyama",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 2999,
  fmv_usd: 200,
  confidence: "HIGH",
  low_confidence_fmv: false,
  low_ask: 150,
  discount_pct: 25,
  discount_usd: 50,
  ask_updated_at: new Date(Date.now() - 3600_000).toISOString(),
  collection_slug: "nba-top-shot",
  collection_name: "NBA Top Shot",
  render_id: null,
  detail_url: "/nba-top-shot/edition/x",
  thumbnail_url: "https://example.com/a.png",
}

const thinRow: Row = {
  external_id: null,
  name: null,
  player_name: null,
  set_name: null,
  tier: null,
  circulation_count: null,
  fmv_usd: null,
  confidence: null,
  low_confidence_fmv: null,
  low_ask: null,
  discount_pct: null,
  discount_usd: null,
  ask_updated_at: null,
  collection_slug: null,
  collection_name: null,
  render_id: null,
  detail_url: null,
  thumbnail_url: null,
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
      } as Response),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DealsBoardClient", () => {
  it("renders deal rows from initialRows including a null-heavy row", () => {
    const { getAllByText } = render(
      <DealsBoardClient initialRows={[fullRow, thinRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    expect(getAllByText(/Victor Wembanyama/).length).toBeGreaterThan(0)
  })

  // 2026-10-18 (Trevor: no user-facing confidence signal). A row whose FMV the
  // route flags low_confidence_fmv renders PLAIN: same price, same dollar gap,
  // no "thin data" caveat and no confidence filter on the page.
  it("renders a low-confidence-FMV row plain, with no confidence caveat or filter", () => {
    const { container } = render(
      <DealsBoardClient
        initialRows={[{ ...fullRow, confidence: "MEDIUM", low_confidence_fmv: true }]}
        initialFetchedAt="2026-07-31T00:00:00Z"
      />,
    )
    // <style> text is CSS (its comments name the removed chip) — not visible copy.
    container.querySelectorAll("style").forEach((el) => el.remove())
    const text = container.textContent ?? ""
    expect(text).toContain("$200")
    expect(text).toContain("−$50")
    expect(text).not.toMatch(/thin data/i)
    expect(text).not.toMatch(/FMV uncertain/i)
    expect(text).not.toMatch(/FMV BASIS/)
    expect(text).not.toMatch(/\bStrict\b/)
    expect(text).not.toMatch(/\b(?:HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
    expect(text).not.toMatch(/confidence/i)
  })

  it("shows the empty state when nothing is listed below FMV", () => {
    const { getByText } = render(<DealsBoardClient initialRows={[]} initialFetchedAt={null} />)
    expect(getByText(/No editions listed below a trustworthy FMV match\./)).toBeTruthy()
  })

  it("changing sort re-fetches the public deals endpoint", () => {
    const { container } = render(
      <DealsBoardClient initialRows={[fullRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    const sort = container.querySelector("select") as HTMLSelectElement
    expect(sort).toBeTruthy()
    fireEvent.change(sort, { target: { value: "fmv" } })
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.some((c) => String(c[0]).includes("/api/public/insights/deals"))).toBe(true)
  })
})

// #207 platform-wide (2026-10-22): a ?player= drill-down the route resolved
// accent-blind ("doncic" → "Luka Dončić") is labelled on the page — never a
// silent subject swap — and "Use this spelling" adopts the catalog name.
describe("DealsBoardClient — an accent-resolved player drill-down", () => {
  it("names the swap and re-queries with the spelling on Use this spelling", async () => {
    window.history.pushState({}, "", "/insights/deals?player=doncic")
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ rows: [{ ...fullRow, player_name: "Luka Dončić", name: "Luka Dončić" }], meta: { fetched_at: null, data_as_of: null, total_rows: 1, elapsed_ms: 1, player_resolved: { from: "doncic", to: "Luka Dončić" } } }),
      } as Response),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { findByText, getByRole } = render(<DealsBoardClient initialRows={[]} initialFetchedAt={null} />)
    const note = (await findByText(/No exact match for/)).closest("[role=status]")!
    expect(note.textContent).toContain("No exact match for “doncic” — showing Luka Dončić.")
    fireEvent.click(getByRole("button", { name: "Use this spelling" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes("player=Luka+Don%C4%8Di%C4%87"))).toBe(true)
    window.history.pushState({}, "", "/")
  })
})
