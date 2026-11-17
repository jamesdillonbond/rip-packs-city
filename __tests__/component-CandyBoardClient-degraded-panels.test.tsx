// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import { readFileSync } from "node:fs"
import React from "react"

import CandyBoardClient from "@/app/insights/candy-mlb/CandyBoardClient"

// deep-audit R18. The page-level banner on /insights/candy-mlb already named
// "Offer spread" among the sections that "could not be loaded … treat the
// affected sections as unknown rather than zero." Roughly 200px below it, the
// SPREAD tab carried a badge of 0 and read "No offers or asks yet." — while the
// MARKET tab on the SAME page reported "WITH A BEST OFFER: 26".
//
// The banner is the best instance of the honesty canon on the site; the panels
// were the un-hardened half. A rows array cannot tell the three states apart —
// a failed read and a genuinely empty section both arrive as [] — so the panel
// has to consume `degraded`, which is the only thing that knows.

const marketRows = [
  {
    external_id: "bobby-witt-jr", player_name: "Bobby Witt Jr.", edition_name: "Bobby Witt Jr.",
    tier: "COMMON", is_rainbow: false, circulation_count: 250, fmv_usd: 8.31,
    fmv_computed_at: "2026-07-27T10:00:00Z", sales_24h: 1, sales_7d: 4, sales_all: 4,
    last_sale_at: "2026-07-27T09:00:00Z", last_sale_usd: 20.04, last_sale_serial: 118,
    median_sale_usd: 4.44, best_offer_usd: 1.5, offer_bidders: 2, floor_ask_usd: 4.58,
    listing_count: 3, excluded_troll_count: 0,
  },
]

const FETCHED_AT = "2026-08-22T16:30:00Z"

function renderBoard(extra: Record<string, unknown>) {
  const props = { initialRows: marketRows, fetchedAt: FETCHED_AT, ...extra } as React.ComponentProps<
    typeof CandyBoardClient
  >
  return render(<CandyBoardClient {...props} />)
}

afterEach(cleanup)

describe("CandyBoardClient — a failed section is unknown, not zero (R18)", () => {
  it("the SPREAD panel says unknown, not 'No offers or asks yet.', when the read failed", () => {
    renderBoard({
      spreads: [],
      degraded: { failed: ["Offer spread"], truncated: [], total: 10, headline: "x" },
    })
    fireEvent.click(screen.getByText("Spread"))

    // Assert the ABSENCE of the false claim, not merely the presence of an
    // error string — a panel rendering both would pass a presence-only check.
    expect(screen.queryByText("No offers or asks yet.")).toBeNull()
    expect(document.body.textContent).toContain("treat it as unknown, not zero")
  })

  it("the SPREAD tab shows NO badge when the section failed, rather than a badge of 0", () => {
    // A badge is a COUNT. Rendering 0 for a failed read is the documented
    // "?? 0 publishes a measured zero" shape one layer up.
    renderBoard({
      spreads: [],
      degraded: { failed: ["Offer spread"], truncated: [], total: 10, headline: "x" },
    })
    const spreadTab = screen.getByText("Spread").closest("button")!
    expect(spreadTab.querySelector(".b")).toBeNull()
  })

  it("a GENUINELY empty section still says so — the fix must not swallow real zeros", () => {
    // NO-CHANGE CONTROL. If the panel reported "unknown" whenever it had no
    // rows, it would be dishonest in the opposite direction and this guard
    // would be the only thing that noticed.
    renderBoard({ spreads: [], degraded: null })
    fireEvent.click(screen.getByText("Spread"))
    expect(screen.getByText("No offers or asks yet.")).toBeTruthy()
    expect(document.body.textContent).not.toContain("treat it as unknown, not zero")
  })

  it("a section that failed does not make its SIBLINGS claim failure", () => {
    // Fix per PANEL cuts both ways: only the named section changes.
    renderBoard({
      spreads: [],
      players: [],
      degraded: { failed: ["Offer spread"], truncated: [], total: 10, headline: "x" },
    })
    fireEvent.click(screen.getByText("Players"))
    expect(screen.getByText("No players.")).toBeTruthy()
  })

  it("a TRUNCATED section reports an incomplete slice rather than a complete one", () => {
    renderBoard({
      spreads: [],
      degraded: { failed: [], truncated: ["Offer spread"], total: 10, headline: "x" },
    })
    fireEvent.click(screen.getByText("Spread"))
    expect(screen.queryByText("No offers or asks yet.")).toBeNull()
    expect(document.body.textContent).toContain("incomplete slice")
  })

  it("every section label the client keys on still exists on the server", () => {
    // ⚠ The client matches `degraded.failed` by STRING. A label renamed on the
    // server alone would silently fall back to the healthy copy — the panel
    // would go quietly back to publishing "No offers or asks yet." on a failed
    // read, with every test above still green because they pass the label in.
    // This is the join that has to be pinned, not the behaviour.
    const client = readFileSync("app/insights/candy-mlb/CandyBoardClient.tsx", "utf8")
    const server = readFileSync("lib/insights/candy-board.ts", "utf8")

    const used = [...client.matchAll(/section(?:EmptyCopy|Badge)\(\s*"([^"]+)"/g)].map((m) => m[1])
    const unique = [...new Set(used)]

    // Satisfiable at zero, and proves the regex actually matched something.
    expect(unique.length).toBeGreaterThan(0)

    for (const label of unique) {
      expect(server, `label "${label}" is not in lib/insights/candy-board.ts`).toContain(`["${label}",`)
    }
  })
})
