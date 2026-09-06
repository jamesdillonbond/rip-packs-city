// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import PackHistoryClient from "@/app/dashboard/packs/PackHistoryClient"
import CollectionOverviewClient from "@/app/(collections)/[collection]/overview/CollectionOverviewClient"

// Two more client pages converted for coverage. NEITHER carried a new defect — both were
// already hardened, and that is the point of recording it here: the next sweep should not
// re-derive them.
//
// `[collection]/overview` is the page deep-audit D11, R1 and R4 each fixed one layer of, and
// it now carries a THREE-way distinction that nothing but a source grep was pinning:
//   read failed          → "Couldn't load this right now"  (about US)
//   read ok, 0 rows      → "No sales in the last 24h"      (about the MARKET)
//   read ok, 0 NAMEABLE  → "N recent sales not yet matched to a moment" (about our CATALOG)
// The third exists because Disney Pinnacle traded 960 times in 24h with 60% of rows carrying
// a NULL edition_id — a catalog-coverage gap, not an ingest regression, so the copy has to
// survive it rather than wait for a fix.
//
// `dashboard/packs` carries the sibling of the copy-pasted saved-wallets defect: a failed
// read must not tell a collector who HAS verified a wallet that they have none and send them
// to the dashboard to redo finished work.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard/packs",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("@/components/InsiderSignalsPanel", () => ({ default: () => <div data-testid="insider" /> }))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => null }))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

beforeEach(() => vi.useRealTimers())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe("PackHistoryClient", () => {
  const WALLETS = { wallets: [{ wallet_addr: "0xmine", verified_at: new Date().toISOString() }] }
  const SUMMARY = {
    wallet: "0xmine",
    totals: {
      packs_purchased: 12, packs_ripped: 7, packs_sold: 3, primary_drops: 5,
      secondary_buys: 7, primary_spent_usd: 90, primary_spend_unknown_count: 0,
      spent_usd: 120, sold_proceeds_usd: 40, ripped_value_usd: 55, net_pl_usd: -25,
      first_event_at: new Date().toISOString(), last_event_at: new Date().toISOString(),
    },
    by_currency: { USD: { spent: 120, proceeds: 40, purchases: 12, sales: 3 } },
    by_collection: [{
      collection_id: "c1", collection_name: "NBA Top Shot", collection_slug: "nba_top_shot",
      spent_usd: 120, proceeds_usd: 40, ripped_value_usd: 55, net_pl_usd: -25,
      activity_total: 12, packs_purchased: 12, packs_ripped: 7, packs_sold: 3,
    }],
  }
  const ROW = (over: Record<string, unknown> = {}) => ({
    pack_nft_id: "p1", dist_id: "77", pack_name: "Series 5 Base", pack_tier: "base",
    pack_image: null, collection_id: "c1", collection_name: "NBA Top Shot",
    collection_slug: "nba_top_shot", status: "ripped", has_buy: true, has_rip: true,
    has_sell: false, buy_price: 9, buy_currency: "USD", bought_at: new Date().toISOString(),
    bought_from: null, sell_price: null, sold_at: null, ripped_at: new Date().toISOString(),
    pull_value_usd: 14, moments_pulled: 3, ...over,
  })

  function mount(opts: {
    wallets?: () => Response
    summary?: () => Response
    history?: () => Response
    lifecycle?: () => Response
  } = {}) {
    const f = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("saved-wallets")) return (opts.wallets ?? (() => json(200, WALLETS)))()
      if (url.includes("pack-summary")) return (opts.summary ?? (() => json(200, SUMMARY)))()
      if (url.includes("pack-lifecycle")) return (opts.lifecycle ?? (() => json(200, { pulls: [], ownership_chain: [] })))()
      if (url.includes("pack-history")) return (opts.history ?? (() => json(200, { packs: [ROW()], total_count: 1 })))()
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<PackHistoryClient />)
    return f
  }

  // ⚠ Sibling of the copy-pasted saved-wallets defect. "No verified wallets yet … Verify a
  // wallet from your dashboard, then come back here" plus an Open dashboard button is
  // actionable in the worst way: it sends a collector to redo work they already finished.
  it.each([
    ["a non-2xx", () => json(500, {}, false)],
    ["a 401", () => json(401, {}, false)],
  ])("does not say the account has no verified wallets after %s", async (_l, r) => {
    mount({ wallets: r as () => Response })
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading wallets/))
    expect(document.body.textContent).not.toMatch(/No saved wallets yet/)
    expect(document.body.textContent).not.toMatch(/Open dashboard/)
  })

  it("does not say the account has no verified wallets after a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<PackHistoryClient />)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading wallets/))
    expect(document.body.textContent).not.toMatch(/No saved wallets yet/)
  })

  it("does say the account has no saved wallets when the read succeeded with none", async () => {
    mount({ wallets: () => json(200, { wallets: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No saved wallets yet/))
  })

  it("renders the summary and the pack table for the active wallet", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    expect(document.body.textContent).toMatch(/NBA Top Shot/)
  })

  // A summary failure and a history failure are separate reads and must fail independently —
  // one broken panel must not blank the other.
  it("keeps the pack table when only the summary read fails", async () => {
    mount({ summary: () => json(500, { error: "summary unavailable" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/summary unavailable/))
    expect(document.body.textContent).toMatch(/Series 5 Base/)
  })

  it("does not say there is no pack activity when the history read failed", async () => {
    mount({ history: () => json(500, { error: "history unavailable" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/history unavailable/))
    expect(document.body.textContent).not.toMatch(/No pack activity for this filter/)
  })

  it("does say there is no pack activity when the read succeeded with none", async () => {
    mount({ history: () => json(200, { packs: [], total_count: 0 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No pack activity for this filter/))
  })

  it("renders the hero stats from the summary", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Packs purchased/))
    expect(document.body.textContent).toMatch(/5 Studio · 7 marketplace/)
    expect(document.body.textContent).toMatch(/Net P&L|Net P&amp;L/)
  })

  // ⚠ THE HONEST HALF OF THE SPEND FIGURE. A primary drop whose retail price never resolved
  // contributes NOTHING to "Total spent", so without this disclosure a collector reads a
  // spend total that silently omits packs they really bought — and then a Net P&L derived
  // from it. It is a floor, and it has to say so.
  it("discloses primary drops whose price could not be resolved", async () => {
    mount({ summary: () => json(200, { ...SUMMARY, totals: { ...SUMMARY.totals, primary_spend_unknown_count: 3 } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/\+3 unpriced/))
  })

  it("does not print the unpriced note when every primary drop resolved", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Packs purchased/))
    expect(document.body.textContent).not.toMatch(/unpriced/)
  })

  it("renders the per-currency breakdown", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/USD/))
  })

  it("renders a lifecycle with its pulls and ownership chain", async () => {
    mount({
      lifecycle: () => json(200, {
        pulls: [{ player_name: "Damian Lillard", fmv_usd: 12, thumbnail_url: null }],
        ownership_chain: [{ address: "0xmine", acquired_at: new Date().toISOString() }],
      }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    fireEvent.click(screen.getByText(/Series 5 Base/))
    await waitFor(() => expect(document.body.textContent).toMatch(/Pulls \(1\)/))
    expect(document.body.textContent).toMatch(/Damian Lillard/)
    expect(document.body.textContent).toMatch(/Ownership chain/)
  })

  // ⚠ A pull with no name must render an em-dash, not an empty cell — a blank tile beside
  // a price reads as a rendering fault rather than a catalog gap.
  it("renders an em-dash for a pull we cannot name", async () => {
    mount({ lifecycle: () => json(200, { pulls: [{ player_name: null, character_name: null, fmv_usd: 12 }], ownership_chain: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    fireEvent.click(screen.getByText(/Series 5 Base/))
    await waitFor(() => expect(document.body.textContent).toMatch(/Pulls \(1\)/))
    expect(document.body.textContent).toMatch(/—/)
  })

  it.each([
    ["held", "held"],
    ["sold", "sold"],
    ["flipped", "flipped"],
    ["other", "other"],
  ])("renders a %s pack row", async (_l, status) => {
    mount({ history: () => json(200, { packs: [ROW({ status, has_rip: false, ripped_at: null, pull_value_usd: null, moments_pulled: null })], total_count: 1 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    expect((document.body.textContent ?? "").toLowerCase()).toContain(status)
  })

  // ⚠ A nameless pack falls back to its nft id, never a blank cell — an unlabelled row in a
  // table of money reads as a rendering fault. Asserted on the POSITIVE marker: the first
  // draft awaited the ABSENCE of "Loading packs…", which is satisfied by the pre-effect
  // render before anything has been fetched at all (two conditions true at different
  // moments do not prove they are ever true together).
  it("renders a pack with no name using its nft id rather than a blank cell", async () => {
    mount({ history: () => json(200, { packs: [ROW({ pack_name: null, pack_nft_id: "abcdef123456" })], total_count: 1 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Pack #123456/))
  })

  it("filters by status and resets to the first page", async () => {
    const f = mount({ history: () => json(200, { packs: [ROW()], total_count: 200 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(f.mock.calls.some((c) => /offset=50\b/.test(String(c[0])))).toBe(true))

    const sold = screen.getAllByRole("button").find((b) => /^sold$/i.test((b.textContent ?? "").trim()))
    if (sold) {
      fireEvent.click(sold)
      // ⚠ Without the reset the new filter is read at the OLD offset, so a collector
      // switching to a filter with three results is shown an empty page and told they have
      // no such packs.
      await waitFor(() =>
        expect(f.mock.calls.some((c) => /offset=0\b/.test(String(c[0])) && /status=sold/.test(String(c[0])))).toBe(true),
      )
    }
  })

  it("filters by collection", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    const tab = screen.getAllByRole("button").find((b) => /^NBA Top Shot$/i.test((b.textContent ?? "").trim()))
    if (tab) {
      fireEvent.click(tab)
      await waitFor(() => expect(f.mock.calls.some((c) => /collection=/.test(String(c[0])))).toBe(true))
    }
  })

  it("expands a row and fetches its lifecycle once", async () => {
    const f = mount({ lifecycle: () => json(200, { pulls: [{ player_name: "Damian Lillard", fmv_usd: 12 }], ownership_chain: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    fireEvent.click(screen.getByText(/Series 5 Base/))
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("pack-lifecycle"))).toBe(true))
    const before = f.mock.calls.filter((c) => String(c[0]).includes("pack-lifecycle")).length
    // Collapse and re-expand: the cache must serve it, not a second request.
    fireEvent.click(screen.getByText(/Series 5 Base/))
    fireEvent.click(screen.getByText(/Series 5 Base/))
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    expect(f.mock.calls.filter((c) => String(c[0]).includes("pack-lifecycle")).length).toBe(before)
  })

  // ⚠ A lifecycle that failed must SAY so inside the expanded row. Rendering the empty
  // "no pulls" shape would tell a collector their pack produced nothing.
  it("states a lifecycle failure inside the expanded row", async () => {
    mount({ lifecycle: () => json(200, { error: "lifecycle unavailable" }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    fireEvent.click(screen.getByText(/Series 5 Base/))
    await waitFor(() => expect(document.body.textContent).toMatch(/lifecycle unavailable/))
  })

  it("cannot page backwards off the first page", async () => {
    const f = mount({ history: () => json(200, { packs: [ROW()], total_count: 200 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    const prev = screen.getAllByRole("button").find((b) => /prev/i.test(b.textContent ?? ""))!
    expect(prev.hasAttribute("disabled")).toBe(true)
    const before = f.mock.calls.length
    fireEvent.click(prev)
    expect(f.mock.calls.length).toBe(before)
  })

  it("stops at the last page rather than paging off the end", async () => {
    const f = mount({ history: () => json(200, { packs: [ROW()], total_count: 100 }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    const nextBtn = () => screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!
    expect(nextBtn().hasAttribute("disabled")).toBe(false)
    fireEvent.click(nextBtn())
    await waitFor(() => expect(f.mock.calls.some((c) => /offset=50\b/.test(String(c[0])))).toBe(true))
    expect(nextBtn().hasAttribute("disabled")).toBe(true)
    const before = f.mock.calls.length
    fireEvent.click(nextBtn())
    expect(f.mock.calls.length).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CollectionOverviewClient — the three-way sales claim", () => {
  const SALE = (over: Record<string, unknown> = {}) => ({
    edition_name: "Damian Lillard — Archive", player_name: "Damian Lillard",
    character_name: null, price: 120, sold_at: new Date().toISOString(),
    tier: "LEGENDARY", set_name: "Archive Set", serial_number: 12, circulation_count: 1000,
    ...over,
  })
  const STATS = (over: Record<string, unknown> = {}) => ({
    edition_count: 19769, fmv_pct: 54.5, volume_24h: 4200, fmv_age_minutes: 12,
    sniper_deals: [], top_sales: [SALE()], ...over,
  })

  const mount = (r: () => Response | Promise<Response>, collection = "nba-top-shot") => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => r()))
    render(<CollectionOverviewClient collection={collection} />)
  }

  it("renders the KPI band and the top sales", async () => {
    mount(() => json(200, STATS()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/19,769/)
    expect(document.body.textContent).toMatch(/\$4,200/)
  })

  // State 2: the read succeeded and the market genuinely did nothing. An honest claim.
  it("says 'no sales in the last 24h' when the read succeeded with none", async () => {
    mount(() => json(200, STATS({ top_sales: [] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/No sales in the last 24h/))
    expect(document.body.textContent).not.toMatch(/not yet matched to a moment/)
  })

  // ⚠ STATE 3, and it is the one a naive fix erases. These sales were READ SUCCESSFULLY —
  // the market traded and our catalog cannot name it — so routing them into state 2 would
  // publish a claim about the MARKET manufactured from a gap in OUR data. Measured live on
  // Disney Pinnacle: 960 sales in 24h, 60% with a NULL edition_id.
  it("says the sales are unmatched — not that there were none — when no row can be named", async () => {
    mount(() => json(200, STATS({
      top_sales: [
        SALE({ edition_name: null, player_name: null, character_name: null }),
        SALE({ edition_name: null, player_name: null, character_name: null }),
      ],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/2 recent sales not yet matched to a moment/))
    expect(document.body.textContent).not.toMatch(/No sales in the last 24h/)
  })

  it("uses the singular for one unmatched sale", async () => {
    mount(() => json(200, STATS({ top_sales: [SALE({ edition_name: null, player_name: null, character_name: null })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/1 recent sale not yet matched/))
    expect(document.body.textContent).not.toMatch(/1 recent sales/)
  })

  // ⚠ A PARTIALLY nameable window is the case that silently serves a 3-row "Top 5" as the
  // complete ranking. The shortfall is DISCLOSED beneath the rows rather than dropped.
  it("discloses the unnamed remainder beneath a partially-nameable top sales list", async () => {
    mount(() => json(200, STATS({
      top_sales: [SALE(), SALE({ edition_name: null, player_name: null, character_name: null })],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/1 more sale in this window not yet matched to a moment/)
  })

  it("does not disclose a remainder when every sale is nameable", async () => {
    mount(() => json(200, STATS({ top_sales: [SALE(), SALE()] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/more sale.? in this window/)
  })

  // ── "Priced from Sales" must be THAT metric or nothing ─────────────────────
  // The cell reads `fmv_high_medium_pct` — the share of editions whose latest FMV
  // rests on corroborated sales. It used to fall back to `fmv_pct`, which is the
  // share carrying ANY non-NO_DATA snapshot and is far larger. Measured live
  // 2026-09-02: LaLiga Golazos 87.3% vs a true 0.3%; UFC Strike 73.6% vs 0.0%.
  it("renders the HIGH/MEDIUM share when the read supplies it", async () => {
    mount(() => json(200, STATS({ fmv_pct: 87.3, fmv_high_medium_pct: 0.3 })), "laliga-golazos")
    await waitFor(() => expect(document.body.textContent).toMatch(/Priced from Sales/))
    expect(document.body.textContent).toMatch(/0%/)
    expect(document.body.textContent).not.toMatch(/87%/)
  })

  // ⚠ ASSERTED AS AN ABSENCE. The failure this prevents is not an error message
  // going missing — it is a DIFFERENT, much larger number being published under
  // this label. So the assertion is that 87% never appears, not that some
  // fallback string does.
  it("publishes no priced-from-sales figure at all when that share is missing", async () => {
    mount(() => json(200, STATS({ fmv_pct: 87.3, fmv_high_medium_pct: null })), "laliga-golazos")
    await waitFor(() => expect(document.body.textContent).toMatch(/Priced from Sales/))
    expect(document.body.textContent).not.toMatch(/87%/)
  })

  // Zero is a measurement, not an absence — UFC Strike's share is genuinely 0.0%.
  it("renders a genuine zero share as 0%", async () => {
    mount(() => json(200, STATS({ fmv_pct: 73.6, fmv_high_medium_pct: 0 })), "ufc-strike")
    await waitFor(() => expect(document.body.textContent).toMatch(/Priced from Sales/))
    expect(document.body.textContent).toMatch(/0%/)
    expect(document.body.textContent).not.toMatch(/74%/)
  })

  // ⚠ A 200 CARRYING AN `error` KEY is a failure, not a collection with no data. Storing it
  // makes `stats` truthy and every KPI reads `stats ? (x ?? 0) : null` — so the whole band
  // would render as "0 editions / 0% priced / $0" instead of em-dashes. That is deep-audit
  // D11, and the guard is kept precisely so no future 200-with-error-body can resurrect it.
  it("treats a 200 carrying an error key as a failure, not as an empty collection", async () => {
    mount(() => json(200, { error: "statement timeout" }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load/))
    expect(document.body.textContent).not.toMatch(/No sales in the last 24h/)
    // The KPI band must not publish a zero edition count out of the failure.
    expect(document.body.textContent).not.toMatch(/\b0 editions\b/)
  })

  it("does not publish a market claim after a thrown fetch", async () => {
    mount(() => { throw new Error("network down") })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load/))
    expect(document.body.textContent).not.toMatch(/No sales in the last 24h/)
    expect(document.body.textContent).not.toMatch(/No deals/)
  })

  it("renders a deal when the sniper feed has one, and an honest empty state when it does not", async () => {
    mount(() => json(200, STATS({
      sniper_deals: [{
        edition_name: "Damian Lillard — Archive", player_name: "Damian Lillard", character_name: null,
        price: 5, fmv: 20, discount_pct: 75, tier: "LEGENDARY", set_name: "Archive Set",
        serial_number: 1, circulation_count: 1000, marketplace: "topshot", listing_url: "https://example.test",
      }],
    })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    cleanup()
    mount(() => json(200, STATS({ sniper_deals: [], top_sales: [] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/No sales in the last 24h/))
  })

  // UFC's Flow market is frozen by design, so a red OUTDATED pill would be permanently wrong
  // — the cry-wolf outcome this repo already paid for with `ufc_fmv_stale_hours`.
  it("does not flag stale FMV as an outage for the frozen UFC market", async () => {
    mount(() => json(200, STATS({ fmv_age_minutes: 100_000 })), "ufc")
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/OUTDATED/i)
  })
})
