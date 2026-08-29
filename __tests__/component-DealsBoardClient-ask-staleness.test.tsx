// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import DealsBoardClient, { type Row } from "@/app/insights/deals/DealsBoardClient"

// ⚠ WHY THIS EXISTS (2026-08-29). /insights/deals is public, no-signup, and its
// whole premise is "listed BELOW fair value right now". `offers-sweep` is the only
// writer of edition_offers.updated_at and normally re-checks every Top Shot edition
// about every 80 minutes (8–18 full wraps a day). During the
// public-api.nbatopshot.com outage it managed ZERO wraps for 24h+: the median Top
// Shot ask age reached 27.9 h and 9 of the 10 Top Shot rows on this board were over
// 12 h unverified — while the page said "Updated 9 minutes ago" beside fixed copy
// reading "Asks refresh continuously". That stamp is the MATERIALIZED VIEW's refresh
// time, so it looks BEST exactly when the underlying feed is deadest.
//
// 🚨 THE CONTROL THAT MATTERS IS THE ALL DAY ONE. `ask_updated_at` does NOT mean the
// same thing across the three UNION branches: Top Shot and Pinnacle carry a
// last-VERIFIED timestamp, but All Day carries `floor_ask_listed_at` — when the
// listing was CREATED. A 90-day-old All Day value means a long-standing listing, not
// an unchecked one, and `allday_edition_floor_ask` has NO verification column to use
// instead. Labelling it "unconfirmed 90d" would be a NEW false claim on a third of
// the board, which is precisely the mistake this test exists to prevent.

const HOUR = 3_600_000

function row(over: Partial<Row> = {}): Row {
  return {
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
    ask_updated_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    collection_slug: "nba_top_shot",
    collection_name: "NBA Top Shot",
    render_id: null,
    detail_url: "/nba-top-shot/edition/x",
    thumbnail_url: null,
    ...over,
  } as Row
}

function draw(rows: Row[]) {
  return render(<DealsBoardClient initialRows={rows} initialFetchedAt="2026-08-29T19:00:00Z" />)
}

afterEach(() => cleanup())

describe("/insights/deals reports how old an ask is instead of implying it is live", () => {
  it("flags a Top Shot ask we have not re-confirmed in over 12 hours", () => {
    const { container } = draw([row({ ask_updated_at: new Date(Date.now() - 28 * HOUR).toISOString() })])
    expect(container.textContent).toMatch(/ask unconfirmed/i)
    expect(container.textContent).toMatch(/28h/)
  })

  it("CONTROL — a freshly re-confirmed ask carries NO caveat (the marker must mean something)", () => {
    const { container } = draw([row({ ask_updated_at: new Date(Date.now() - 1 * HOUR).toISOString() })])
    expect(container.textContent).not.toMatch(/ask unconfirmed/i)
  })

  it("🚨 CONTROL — an OLD All Day timestamp is NOT flagged: there it means 'listed at', not 'last checked'", () => {
    const { container } = draw([
      row({
        collection_slug: "nfl_all_day",
        collection_name: "NFL All Day",
        ask_updated_at: new Date(Date.now() - 90 * 24 * HOUR).toISOString(),
      }),
    ])
    expect(
      container.textContent,
      "All Day's column is floor_ask_listed_at — calling a long-standing listing 'unconfirmed' is a NEW false claim",
    ).not.toMatch(/ask unconfirmed/i)
  })

  it("the header stops asserting 'Asks refresh continuously' when the rows say otherwise", () => {
    const { container } = draw([
      row({ ask_updated_at: new Date(Date.now() - 28 * HOUR).toISOString() }),
      row({ external_id: "b", ask_updated_at: new Date(Date.now() - 1 * HOUR).toISOString() }),
    ])
    expect(container.textContent).not.toMatch(/Asks refresh continuously/i)
    expect(container.textContent).toMatch(/1 of 2 asks unconfirmed/i)
  })

  it("CONTROL — with every ask fresh, the header keeps the steady-state claim", () => {
    const { container } = draw([row(), row({ external_id: "b" })])
    expect(
      container.textContent,
      "the claim is TRUE in steady state — deleting it outright would remove accurate information",
    ).toMatch(/Asks refresh continuously/i)
    expect(container.textContent).not.toMatch(/asks unconfirmed/i)
  })

  // ⚠ ASSERTED BY SSR, NOT BY jsdom. CLAUDE.md's standing rule: a mount effect
  // corrects the state before jsdom looks, so a client-only render passes whether
  // or not the SSR output is safe. This component is imported directly by a server
  // page and hydrated, so the ONLY thing that proves the staleness marker cannot
  // cause React #418 is that the server render does not contain it at all.
  it("without a server clock, nothing ask-aged reaches the SSR HTML (no clock read during render)", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <DealsBoardClient
        initialRows={[row({ ask_updated_at: new Date(Date.now() - 28 * HOUR).toISOString() })]}
        initialFetchedAt="2026-08-29T19:00:00Z"
      />,
    )
    expect(html, "an ask-age derived from a render-time clock can disagree between server and client").not.toMatch(/ask unconfirmed/i)
    // The row itself must still server-render — the fix must not cost crawlability.
    expect(html).toMatch(/Wembanyama/)
  })

  // 🚨 THE POINT OF PASSING THE SERVER'S CLOCK. A post-mount-only marker leaves the
  // RAW HTML still asserting "Asks refresh continuously" — so a reader with JS
  // disabled, and every crawler, gets the false claim. Seeding from a prop puts the
  // honesty in the server render AND stays hydration-safe, because the value is
  // serialised rather than re-read.
  it("🚨 with the server's clock, the staleness IS in the SSR HTML — and matches the client exactly", async () => {
    const { renderToString } = await import("react-dom/server")
    // A FIXED clock and FIXED timestamps: the two renders must agree by construction,
    // which is what a hydration mismatch would break.
    const nowMs = Date.parse("2026-08-29T20:00:00.000Z")
    const rows = [row({ ask_updated_at: "2026-08-28T16:00:00.000Z" })] // 28h before nowMs
    const props = { initialRows: rows, initialFetchedAt: "2026-08-29T19:00:00Z", initialNowMs: nowMs }

    // ⚠ React separates adjacent text nodes with `<!-- -->` in SSR output, so
    // `ask unconfirmed <!-- -->28h` does not match a naive regex. Strip the
    // separators first — what matters is the text a reader sees.
    const html = renderToString(<DealsBoardClient {...props} />).replace(/<!-- -->/g, "")
    expect(html, "a no-JS reader must see the age too").toMatch(/ask unconfirmed 28h/i)
    expect(html).toMatch(/1 of 1 asks unconfirmed/i)
    expect(html, "the false steady-state claim must not survive into the raw HTML").not.toMatch(/Asks refresh continuously/i)

    // ⚠ COMPARING SSR TO THE POST-EFFECT DOM IS THE WRONG TEST, and writing it that
    // way first is instructive: it failed 28h vs 29h, which is NOT a hydration
    // mismatch — it is the mount effect refreshing `nowMs` to the real clock, exactly
    // as designed. Hydration safety is about the FIRST client render, which uses the
    // prop. So the clock is pinned to the same instant, making the effect a no-op and
    // leaving only the property that matters: server and client agree on the value
    // derived from the prop.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowMs))
    try {
      const { container } = render(<DealsBoardClient {...props} />)
      const ssrAge = /ask unconfirmed (\d+[hd])/i.exec(html)?.[1]
      const domAge = /ask unconfirmed (\d+[hd])/i.exec(container.textContent ?? "")?.[1]
      expect(ssrAge, "SSR produced no ask age to compare").toBeTruthy()
      expect(domAge, "server and client disagree on the ask age — that is React #418").toBe(ssrAge)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the stamp names what it actually measures — the board rebuild, not the ask age", () => {
    const { container } = draw([row()])
    expect(container.textContent).toMatch(/Board rebuilt/i)
  })
})
