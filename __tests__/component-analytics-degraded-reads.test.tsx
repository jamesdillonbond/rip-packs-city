// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

// The /analytics client dashboards each fetched with a variant of
//
//     fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => {})
//
// which turns a network failure, a 5xx, an unparseable body and a genuinely
// empty result into the same value. Every one of them then rendered a SENTENCE
// off that value — and the sentences are not hedges, they are findings:
//
//   "No recent whale trades."
//   "No Flowty marketplace activity in this window."
//   "No buyer-resolved accumulation in the last 7d yet."
//   "No positive-EV packs in this filter."
//   "No new pack listings in the last 24 hours."
//   "Pack analytics not yet available for this collection."   (x5 at once)
//   "No significant movers in this window — try a longer time range or lower
//    min FMV floor."
//
// The last is the sharpest: it does not merely state a false finding, it tells
// the reader to loosen a filter that was never the problem. The Packs KPI strip
// went further still and printed "Packs Tracked 0" and "0.0% of tracked" as
// measurements.
//
// This is the same class the /insights sweep closed server-side. These were
// never swept because their failure path is a `.catch` in a useEffect rather
// than an `if (error)` in a server page, so the server-side grep finds none of
// them.
//
// Each test below asserts BOTH halves — the fabricated claim is gone AND an
// honest one took its place — because dropping the copy entirely would leave a
// blank card, which is the same lie with fewer words. Every file also has an
// empty-but-successful case, since a fix that just always says "couldn't load"
// would pass a failure-only test while destroying the real empty state.

import PacksDashboard from "@/components/analytics/PacksDashboard"
import RecentWhaleTrades from "@/components/analytics/RecentWhaleTrades"
import NetMarketplaceLeaderboard from "@/components/analytics/NetMarketplaceLeaderboard"
import TopBuyers from "@/components/analytics/TopBuyers"
import FmvDashboard from "@/components/analytics/FmvDashboard"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Every request 500s — the DB-saturation case these pages actually hit. */
function stubAllFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as never)
  )
}

/** Every request succeeds with a genuinely empty result. */
function stubAllEmpty(body: unknown = { rows: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as never)
  )
}

const text = () => document.body.textContent ?? ""

describe("PacksDashboard", () => {
  it("does not state three market findings when all three reads fail", async () => {
    stubAllFail()
    render(<PacksDashboard />)
    expect(await screen.findByText(/Couldn't load top-EV packs/)).toBeTruthy()

    const t = text()
    expect(t).not.toContain("No positive-EV packs in this filter")
    expect(t).not.toContain("No new pack listings in the last 24 hours")
    // Five muted panels asserting a product gap, from one failed request.
    expect(t).not.toContain("Pack analytics not yet available for this collection")
    expect(t).toContain("Couldn't load fresh drops")
    expect(t).toContain("Couldn't load pack analytics")
  })

  it("reports the failure as a failure, naming the affected sections", async () => {
    stubAllFail()
    render(<PacksDashboard />)
    await screen.findByText(/Couldn't load top-EV packs/)
    // The shared /insights notice: says explicitly that a blank is a load
    // failure and the sections are unknown rather than zero.
    expect(text()).toMatch(/temporary database-load failure, not an empty result/)
    expect(text()).toContain("Per-collection summary")
  })

  it("does not print 0 packs tracked as a measurement", async () => {
    stubAllFail()
    render(<PacksDashboard />)
    await screen.findByText(/Couldn't load top-EV packs/)
    const t = text()
    expect(t).toContain("Packs Tracked")
    // "0" and "0.0% of tracked" were rendered by the same formatters that
    // render an em-dash for null.
    expect(t).not.toContain("0.0% of tracked")
    expect(t).toMatch(/—/)
  })

  it("STILL says 'no positive-EV packs' on a successful empty read", async () => {
    // The mirror case. Without it, hard-coding the failure copy everywhere
    // would pass every assertion above.
    stubAllEmpty({ rows: [], collections: {} })
    render(<PacksDashboard />)
    expect(await screen.findByText(/No positive-EV packs in this filter/)).toBeTruthy()
    expect(text()).toContain("No new pack listings in the last 24 hours")
    expect(text()).not.toMatch(/temporary database-load failure/)
  })
})

describe("RecentWhaleTrades", () => {
  it("does not report an absence of whale activity when the read fails", async () => {
    stubAllFail()
    render(<RecentWhaleTrades />)
    expect(await screen.findByText(/Couldn't load recent whale trades/)).toBeTruthy()
    expect(text()).not.toContain("No recent whale trades.")
  })

  it("still reports a genuinely quiet window", async () => {
    stubAllEmpty()
    render(<RecentWhaleTrades />)
    expect(await screen.findByText(/No recent whale trades\./)).toBeTruthy()
  })
})

describe("NetMarketplaceLeaderboard", () => {
  it("does not claim the marketplace was idle when the read fails", async () => {
    stubAllFail()
    render(<NetMarketplaceLeaderboard />)
    expect(await screen.findByText(/Couldn't load marketplace activity/)).toBeTruthy()
    expect(text()).not.toContain("No Flowty marketplace activity in this window.")
  })

  it("still reports a genuinely idle window", async () => {
    stubAllEmpty()
    render(<NetMarketplaceLeaderboard />)
    expect(await screen.findByText(/No Flowty marketplace activity in this window\./)).toBeTruthy()
  })
})

describe("TopBuyers", () => {
  it("does not report an absence of accumulation when the read fails", async () => {
    // This one had the leak twice over: the !r.ok branch AND the catch both
    // called setRows([]), so a failure was indistinguishable by construction.
    stubAllFail()
    render(<TopBuyers />)
    expect(await screen.findByText(/Couldn't load buyer accumulation/)).toBeTruthy()
    expect(text()).not.toMatch(/No buyer-resolved accumulation/)
  })

  it("still reports genuinely absent accumulation", async () => {
    stubAllEmpty()
    render(<TopBuyers />)
    expect(await screen.findByText(/No buyer-resolved accumulation/)).toBeTruthy()
  })
})

describe("FmvDashboard", () => {
  it("stops telling the reader to loosen a filter when the read failed", async () => {
    // Note this component did not even check r.ok — it parsed the error body
    // and stored it as the response, so `rows` fell through to [].
    stubAllFail()
    render(<FmvDashboard />)
    expect(await screen.findByText(/Couldn't load top movers/)).toBeTruthy()
    const t = text()
    expect(t).not.toMatch(/try a longer time range or lower min FMV floor/)
    expect(t).not.toContain("No tier data available.")
    expect(t).toMatch(/Couldn't load tier data/)
  })

  it("still gives the filter advice on a successful empty result", async () => {
    // Here the advice is correct and useful — the window really is empty.
    stubAllEmpty()
    render(<FmvDashboard />)
    expect(
      await screen.findByText(/try a longer time range or lower min FMV floor/)
    ).toBeTruthy()
    expect(text()).toContain("No tier data available.")
  })
})
