// @vitest-environment jsdom
//
// Deep-audit R1 (P0). The two list panels on /[collection]/overview applied
// `?? 0` to a NULL `stats` and rendered "No sales in the last 24h" / "No deals
// >=15% off right now" — a claim about the MARKET manufactured from an outage
// of OURS. Measured 2026-08-15 while /api/collection-stats was honestly 503ing:
// Top Shot had done 8,332 sales and All Day 240 in the window both pages called
// empty, and the page contradicted itself on screen (its own Insider Signals
// panel listed 269- and 171-moment sweeps from 1-2h earlier).
//
// Pinned in BOTH directions deliberately. A fix that always says "couldn't
// load" trades one false claim for another: a collection that genuinely has no
// deals right now must still say so. The distinguishing question is "did the
// READ succeed", never "were there rows".
import React from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useParams: () => ({ collection: "nba-top-shot" }),
}))

// Child panels do their own fetching and are not under test here.
vi.mock("@/components/InsiderSignalsPanel", () => ({
  default: () => <div data-testid="insider-signals" />,
}))
vi.mock("@/components/marketplace-status", () => ({
  MarketplaceStatusBanner: () => null,
}))

import OverviewPage from "@/app/(collections)/[collection]/overview/page"

const EMPTY_BUT_SUCCESSFUL = {
  edition_count: 19769,
  fmv_pct: 54.5,
  volume_24h: 0,
  fmv_age_minutes: 12,
  sniper_deals: [],
  top_sales: [],
}

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl) as unknown as typeof fetch)
}

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response)

describe("overview panels: a failed read must not render as a market fact", () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => {
    // Explicit: this config does not enable RTL auto-cleanup, so without it
    // each render appends to document.body and the PREVIOUS case's panels are
    // still matchable — the empty-state cases then find the failed-read copy
    // left over from the cases above and appear to fail. Caught exactly that way.
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("503 from /api/collection-stats renders 'couldn't load', NEVER 'No sales in the last 24h'", async () => {
    mockFetch(() => jsonResponse({ error: "the database is under heavy load", code: "timeout" }, 503))
    render(<OverviewPage />)

    await waitFor(() => {
      expect(screen.getAllByText(/Couldn.t load this right now/i).length).toBeGreaterThanOrEqual(2)
    })

    // The exact false claims this defect produced.
    expect(screen.queryByText(/No sales in the last 24h/i)).toBeNull()
    expect(screen.queryByText(/No deals/i)).toBeNull()
  })

  it("a 200 body carrying `error` is also a failed read, not an empty market", async () => {
    // The route returns 503 today, but this second path exists so no future
    // 200-with-error-body can resurrect the bug (same reasoning as D11).
    mockFetch(() => jsonResponse({ error: "boom" }, 200))
    render(<OverviewPage />)

    await waitFor(() => {
      expect(screen.getAllByText(/Couldn.t load this right now/i).length).toBeGreaterThanOrEqual(2)
    })
    expect(screen.queryByText(/No sales in the last 24h/i)).toBeNull()
  })

  it("a SUCCESSFUL read with zero rows still renders the honest empty state", async () => {
    mockFetch(() => jsonResponse(EMPTY_BUT_SUCCESSFUL, 200))
    render(<OverviewPage />)

    await waitFor(() => {
      expect(screen.getByText(/No sales in the last 24h/i)).toBeTruthy()
    })
    expect(screen.getByText(/No deals/i)).toBeTruthy()
    expect(screen.queryByText(/Couldn.t load this right now/i)).toBeNull()
  })

  it("top sales that all fail the name filter render the empty state, not a blank panel", async () => {
    // Deep-audit R4: the guard used to test the RAW array. When every row
    // resolved to a dash it saw length 5, skipped the empty state, and the
    // name filter then stripped all 5 — a blank panel with no copy at all.
    // Live on /disney-pinnacle/overview, where a Pinnacle ingest regression
    // left every top sale with a NULL edition_id.
    mockFetch(() =>
      jsonResponse(
        {
          ...EMPTY_BUT_SUCCESSFUL,
          top_sales: Array.from({ length: 5 }, () => ({
            edition_name: null,
            player_name: null,
            character_name: null,
            price_usd: 100,
            sold_at: new Date().toISOString(),
          })),
        },
        200,
      ),
    )
    render(<OverviewPage />)

    await waitFor(() => {
      expect(screen.getByText(/No sales in the last 24h/i)).toBeTruthy()
    })
    // And it must not have claimed an outage — the read succeeded.
    expect(screen.queryByText(/Couldn.t load this right now/i)).toBeNull()
  })
})
