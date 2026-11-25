// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import React from "react"

import CandyBoardClient from "@/app/insights/candy-mlb/CandyBoardClient"

// Candy "Floor movers · 7 days" (2026-11-24). mv_candy_floor_movers is EMPTY BY CONSTRUCTION until the 2026-12-01
// lane row (OpenSea asks joined the book 11-23). So the empty tab must not conclude "no floor moved" before then, and
// a failed read must not read as an empty market either.

const FETCHED_AT = "2026-11-24T16:00:00Z"
function renderBoard(extra: Record<string, unknown>) {
  const props = { initialRows: [], fetchedAt: FETCHED_AT, ...extra } as React.ComponentProps<typeof CandyBoardClient>
  return render(<CandyBoardClient {...props} />)
}
afterEach(cleanup)

const mover = {
  external_id: "bobby-witt-jr", player_name: "Bobby Witt Jr.", edition_name: "Bobby Witt Jr.", tier: "COMMON",
  is_rainbow: false, circulation_count: 250, ask_then_usd: 4, ask_now_usd: 6, listed_now: 3, change_usd: 2,
  change_pct: 50, direction: "rise", day_then: "2026-11-24", day_now: "2026-12-01", window_complete: true,
}

describe("CandyBoardClient — Floor movers tab", () => {
  it("empty: names the venue change point instead of claiming no floor moved", () => {
    renderBoard({ movers: [] })
    fireEvent.click(screen.getByText("Floor movers"))
    const text = document.body.textContent ?? ""
    expect(text).toContain("OpenSea asks joined Candy's book on Nov 23, 2026")
    expect(text).toContain("Dec 1")
    expect(text).not.toMatch(/No 2026 Base edition's floor moved\.?$/m)
  })

  it("a failed read is unknown, not an empty market — and carries no badge", () => {
    renderBoard({ movers: [], degraded: { failed: ["Floor movers"], truncated: [], total: 11, headline: "x" } })
    const tab = screen.getByText("Floor movers")
    expect(tab.querySelector(".b")).toBeNull()
    fireEvent.click(tab)
    expect(document.body.textContent).toContain("treat it as unknown, not zero")
    expect(document.body.textContent).not.toContain("OpenSea asks joined Candy's book")
  })

  it("rows render both floors and the change; an incomplete window says so", () => {
    renderBoard({ movers: [mover, { ...mover, external_id: "b", window_complete: false }] })
    fireEvent.click(screen.getByText("Floor movers"))
    const text = document.body.textContent ?? ""
    expect(text).toContain("Bobby Witt Jr.")
    expect(text).toContain("50.0%")
    expect(text).toContain("missed a day inside this window")
    // 2026-11-24: mv_candy_floor_movers has no set filter, so the copy must not describe it as 2026 Base only.
    expect(text).toContain("every set, not only 2026 Base")
    expect(text).not.toContain("each 2026 Base edition")
  })
})
