// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// /insights/autographs client. Pins: rows render with drill-downs to the SIGNED
// edition and to its unsigned printing; a NULL premium renders "—" (never a
// guessed ratio); a failed server read says it failed rather than "no signed
// editions"; a failed refetch clears the previous tab's rows; and no FMV or
// confidence vocabulary reaches the page.

import AutographsBoardClient from "@/app/insights/autographs/AutographsBoardClient"
import type { AutographRow } from "@/lib/insights/autographs-board"

const row = (over: Partial<AutographRow> = {}): AutographRow => ({
  edition_id: "e1",
  external_id: "219:7408::18",
  collection: "nba_top_shot",
  player_name: "Cooper Flagg",
  team_name: "Dallas Mavericks",
  set_name: "Rookie Debut",
  parallel: "Hardcourt",
  tier: "COMMON",
  series: 8,
  circulation_count: 50,
  thumbnail_url: null,
  low_ask: 2999,
  ask_seen_at: "2026-10-19T20:00:00Z",
  sales_90d: 4,
  median_90d: 1795,
  last_sale_usd: 1600,
  last_sale_at: "2026-10-01T18:00:00Z",
  unsigned_external_id: "219:7408",
  unsigned_parallel: null,
  unsigned_median_90d: 120,
  unsigned_sales_90d: 30,
  premium_x: 14.96,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AutographsBoardClient", () => {
  it("renders the signed edition, its unsigned printing, and links both", () => {
    const { container } = render(
      <AutographsBoardClient initialRows={[row(), row({ edition_id: "e2", premium_x: null, unsigned_external_id: null })]} initialFetchedAt="2026-10-20T04:00:00Z" />,
    )
    expect(container.textContent).toContain("Hardcourt")
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/nba-top-shot/edition/219%3A7408%3A%3A18")
    expect(hrefs).toContain("/nba-top-shot/edition/219%3A7408")
    expect(container.textContent).toContain("15×")
    // the second row has no premium and no unsigned printing: dashes, never a number
    const cells = [...container.querySelectorAll("tbody tr")][1].querySelectorAll("td")
    expect(cells[cells.length - 1].textContent).toBe("—")
  })

  it("never shows FMV or confidence vocabulary", () => {
    const { container } = render(<AutographsBoardClient initialRows={[row()]} initialFetchedAt="2026-10-20T04:00:00Z" />)
    expect(container.textContent ?? "").not.toMatch(/\bFMV\b|confidence|HIGH|MEDIUM|ASK_ONLY/)
  })

  it("a failed SERVER read says it failed, not that nothing is signed", () => {
    const { container } = render(<AutographsBoardClient initialRows={[]} initialFetchedAt={null} initialFailed />)
    expect(container.textContent).toContain("Couldn")
    expect(container.textContent).not.toContain("No signed editions match")
    expect(container.textContent).toContain("Updated —")
  })

  it("a genuinely empty read is a real 'none'", () => {
    const { container } = render(<AutographsBoardClient initialRows={[]} initialFetchedAt="2026-10-20T04:00:00Z" />)
    expect(container.textContent).toContain("No signed editions match this view.")
  })

  it("switching collection refetches that collection; a failed refetch clears the old rows", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "x" }), text: async () => "{}" })
    const { getByText, container } = render(<AutographsBoardClient initialRows={[row()]} initialFetchedAt="2026-10-20T04:00:00Z" />)
    fireEvent.click(getByText("NFL All Day"))
    await waitFor(() => expect(container.textContent).toContain("Couldn"))
    expect(String(fetchMock.mock.calls[0][0])).toContain("collection=nfl_all_day")
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0)
  })
})
