// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import OfferSpreadBoardClient, { type Row } from "@/app/insights/offer-spread/OfferSpreadBoardClient"

// ⚠ WHY THIS EXISTS (2026-08-29). /insights/offer-spread is public and no-signup, and
// every number on it is BID MINUS ASK — so a frozen ask side does not merely age one
// column, it moves every row, every KPI, and the "≥ floor" arbitrage chip. On
// 2026-08-29 `offers-sweep` (the only writer of the ask side of `edition_offers`) had
// been failing against a dead upstream for over a day: 12,259 Top Shot asks at a
// MEDIAN age of 30.0 h, p90 30.3 h, 150 of 12,259 refreshed in twelve hours.
//
// 🚨 THE BOARD SELECTED `updated_at`, TYPED IT ON `Row`, AND NEVER RENDERED IT. The
// answer was already on the wire — server render and client refetch both — while the
// header asserted "Refreshes continuously" as FIXED COPY beside a stamp built from
// `new Date().toISOString()` on the server page. So it read "Updated 30 seconds ago ·
// Refreshes continuously" over asks nobody had confirmed in thirty hours: two
// manufactured freshness claims stacked on one honest number.
//
// ⚠ THE STAMP AND THE ASK AGE ARE DIFFERENT MEASUREMENTS. This board queries the live
// view, so the stamp genuinely says when WE looked — that part was never wrong. The
// defect was letting it stand in for how old the DATA is, and hardcoding the second
// claim so it could not be falsified.

const HOUR = 3_600_000

function row(over: Partial<Row> = {}): Row {
  return {
    external_id: "141:5156",
    name: "Victor Wembanyama",
    player_name: "Victor Wembanyama",
    set_name: "Base Set",
    tier: "MOMENT_TIER_LEGENDARY",
    circulation_count: 2999,
    highest_offer: 140,
    low_ask: 150,
    offer_pct_of_ask: 93.3,
    par_distance: 6.7,
    spread_usd: 10,
    bid_meets_ask: false,
    updated_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    ...over,
  } as Row
}

function draw(rows: Row[]) {
  return render(<OfferSpreadBoardClient initialRows={rows} initialFetchedAt="2026-08-29T19:00:00Z" />)
}

afterEach(() => cleanup())

describe("/insights/offer-spread reports how old an ask is instead of implying it is live", () => {
  it("flags an ask we have not re-confirmed in over 12 hours", () => {
    const { container } = draw([row({ updated_at: new Date(Date.now() - 30 * HOUR).toISOString() })])
    expect(container.textContent).toMatch(/ask unconfirmed/i)
    expect(container.textContent).toMatch(/30h/)
  })

  it("CONTROL — a freshly re-confirmed ask carries NO caveat (the marker must mean something)", () => {
    const { container } = draw([row({ updated_at: new Date(Date.now() - 1 * HOUR).toISOString() })])
    expect(container.textContent).not.toMatch(/ask unconfirmed/i)
    // ...and the steady-state claim is allowed to stand when it is TRUE.
    expect(container.textContent).toMatch(/Refreshes continuously/i)
  })

  it("CONTROL — a row with NO timestamp is not flagged and not called fresh either", () => {
    // Unknown age is the third state. Rendering it as stale invents a measurement;
    // rendering it as fresh is the failed-read-as-answer shape one layer down.
    const { container } = draw([row({ updated_at: null })])
    expect(container.textContent).not.toMatch(/ask unconfirmed/i)
    expect(container.textContent).not.toMatch(/asks unconfirmed/i)
  })

  it("🚨 the hardcoded 'Refreshes continuously' claim is REPLACED by a derived one when it is false", () => {
    const { container } = draw([
      row({ external_id: "1:1", updated_at: new Date(Date.now() - 30 * HOUR).toISOString() }),
      row({ external_id: "1:2", updated_at: new Date(Date.now() - 2 * HOUR).toISOString() }),
    ])
    // Assert the ABSENCE of the false claim, not merely the presence of a warning:
    // a page that says both is still telling the reader the feed is healthy.
    expect(
      container.textContent,
      "the unfalsifiable steady-state claim survived alongside the correction",
    ).not.toMatch(/Refreshes continuously/i)
    expect(container.textContent).toMatch(/1 of 2 asks unconfirmed/i)
  })

  it("names what the stamp actually measures — when we queried, not how old the asks are", () => {
    const { container } = draw([row()])
    expect(container.textContent).toMatch(/Board queried/i)
  })

  // ⚠ ASSERTED BY SSR, NOT BY jsdom. A mount effect corrects the state before jsdom
  // looks, so a client-only render passes whether or not the SSR output is safe.
  it("without a server clock, nothing ask-aged reaches the SSR HTML (no clock read during render)", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <OfferSpreadBoardClient
        initialRows={[row({ updated_at: new Date(Date.now() - 30 * HOUR).toISOString() })]}
        initialFetchedAt="2026-08-29T19:00:00Z"
      />,
    )
    expect(html, "an ask age derived from a render-time clock can disagree between server and client").not.toMatch(/ask unconfirmed/i)
    // The row itself must still server-render — the fix must not cost crawlability.
    expect(html).toMatch(/Wembanyama/)
  })

  it("🚨 with the server's clock, the staleness IS in the SSR HTML — and matches the client exactly", async () => {
    const { renderToString } = await import("react-dom/server")
    const nowMs = Date.parse("2026-08-29T22:00:00.000Z")
    const rows = [row({ updated_at: "2026-08-28T16:00:00.000Z" })] // 30h before nowMs
    const props = { initialRows: rows, initialFetchedAt: "2026-08-29T21:55:00Z", initialNowMs: nowMs }

    // React separates adjacent text nodes with `<!-- -->` in SSR output.
    const html = renderToString(<OfferSpreadBoardClient {...props} />).replace(/<!-- -->/g, "")
    expect(html, "a no-JS reader and every crawler must see the age too").toMatch(/ask unconfirmed 30h/i)
    expect(html).toMatch(/1 of 1 asks unconfirmed/i)
    expect(html, "the false steady-state claim must not survive into the raw HTML").not.toMatch(/Refreshes continuously/i)

    // Pin the clock so the mount effect is a no-op; what is under test is that the
    // FIRST client render agrees with the server, which is what React #418 breaks.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowMs))
    try {
      const { container } = render(<OfferSpreadBoardClient {...props} />)
      const ssrAge = /ask unconfirmed (\d+[hd])/i.exec(html)?.[1]
      const domAge = /ask unconfirmed (\d+[hd])/i.exec(container.textContent ?? "")?.[1]
      expect(ssrAge, "SSR produced no ask age to compare").toBeTruthy()
      expect(domAge, "server and client disagree on the ask age — that is React #418").toBe(ssrAge)
    } finally {
      vi.useRealTimers()
    }
  })
})
