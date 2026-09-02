// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

// Deeper branch coverage for the two WEAKEST files in the component gate:
// app/insights/tc-report/page.tsx (55.1% br) and
// app/insights/pack-reality/page.tsx (51.7% br) — measured 2026-08-11.
//
// The sibling component-insights-client-pages.test.tsx proves each page mounts
// and handles the primary success/error path. What stayed dark was the display
// logic underneath: the money/percent/date FORMATTER LADDERS and the optional
// report sections. That matters more than a coverage number implies, because
// these are the two PUBLIC wallet-paste tools — a formatter that silently
// renders the wrong magnitude ("$4k" for $4,000 vs "$4.0k") or an em-dash where
// a real number exists is a data-honesty bug on a public surface, and it is
// invisible to a test that only asserts the page rendered.
//
// Deliberately asserted through the RENDERED DOM rather than by exporting the
// formatters: they are module-private, and extracting them purely to make them
// testable would change the shipped file for the test's convenience.

import TcReportPage from "@/app/insights/tc-report/page"
import PackRealityPage from "@/app/insights/pack-reality/page"

const VALID_WALLET = "0xbd94cade097e50ac"

function jsonOnce(payload: unknown, ok = true, status = 200) {
  return vi.fn(() => Promise.resolve({ ok, status, json: async () => payload } as Response))
}

beforeEach(() => {
  window.history.replaceState({}, "", "/insights/tc-report")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Minimal squeeze block — the report renders nothing without it. */
function squeeze(over: Record<string, unknown> = {}) {
  return {
    wallet: VALID_WALLET,
    total_moments: 200,
    total_editions: 100,
    buckets: {
      liquid: { editions: 40, moments: 80 },
      moderate: { editions: 20, moments: 40 },
      squeezed: { editions: 25, moments: 50 },
      extreme: { editions: 15, moments: 30 },
    },
    top_squeezed: [],
    ...over,
  }
}

async function runReport(report: unknown) {
  // The page reads `j.report`, not the bare body.
  vi.stubGlobal("fetch", jsonOnce({ report }))
  render(<TcReportPage />)
  fireEvent.change(screen.getByLabelText(/Flow wallet address/i), {
    target: { value: VALID_WALLET },
  })
  fireEvent.click(screen.getByText(/Run report/i))
  await waitFor(() => expect(screen.queryByText(/Run report/i)).toBeTruthy())
}

describe("TcReportPage — money + percent formatter ladders", () => {
  it("renders each fmtUsd magnitude band distinctly", async () => {
    // The ladder has four rungs and they are easy to get wrong by an order of
    // magnitude: >=10000 drops the decimal ($42k), >=1000 keeps one ($4.2k),
    // >=100 drops cents ($420), below that keeps cents ($42.50).
    await runReport({
      squeeze: squeeze(),
      cross_collection: [
        { slug: "nba_top_shot", moments: 1, editions: 1, approx_fmv_usd: 42000 },
        { slug: "nfl_all_day", moments: 1, editions: 1, approx_fmv_usd: 4200 },
        { slug: "laliga_golazos", moments: 1, editions: 1, approx_fmv_usd: 420 },
        { slug: "ufc_strike", moments: 1, editions: 1, approx_fmv_usd: 42.5 },
        { slug: "disney_pinnacle", moments: 1, editions: 1, approx_fmv_usd: null },
      ],
    })

    // The value sits inside "\u2248 $42k FMV", so the text node is split —
    // assert on the rendered document text rather than an exact-node match.
    await waitFor(() => expect(document.body.textContent).toContain("$42k"))
    const text = document.body.textContent ?? ""
    expect(text).toContain("$4.2k")
    expect(text).toContain("$420")
    expect(text).toContain("$42.50")
    // A missing valuation renders NO FMV line at all (the `!= null` guard),
    // never "$0" — a fabricated zero would read as a real valuation.
    // The null-FMV collection renders NO FMV line at all (the `!= null` guard)
    // rather than "$0" — a fabricated zero would read as a real valuation.
    expect(text).not.toContain("$0.00")
    const pinnacleCard = screen.getByText("Disney Pinnacle").closest(".rpc-tc-cc-card")
    expect(pinnacleCard).toBeTruthy()
    expect(pinnacleCard?.textContent ?? "").not.toContain("FMV")
  })

  it("labels known collection slugs and falls back to the raw slug for unknown ones", async () => {
    await runReport({
      squeeze: squeeze(),
      cross_collection: [
        { slug: "nba_top_shot", moments: 5, editions: 5, approx_fmv_usd: 100 },
        { slug: "some_future_chain", moments: 2, editions: 2, approx_fmv_usd: 50 },
      ],
    })
    // An unmapped slug must still render (a new collection must not blank the
    // row), which is the `?? c.slug` fallback.
    await waitFor(() => expect(screen.getByText("some_future_chain")).toBeTruthy())
  })

  it("renders the squeeze table with tier + percent formatting", async () => {
    await runReport({
      squeeze: squeeze({
        top_squeezed: [
          {
            player_name: "Damian Lillard",
            set_name: "Base Set",
            tier: "LEGENDARY",
            edition_key: "1:2",
            circulation: 1000,
            locked: 400,
            burned: 350,
            squeeze_pct: 75,
            held: 3,
          },
          {
            // Null-heavy row: every display field must degrade to an em-dash
            // rather than "null" or NaN.
            player_name: null,
            set_name: null,
            tier: null,
            edition_key: "3:4",
            circulation: null,
            locked: null,
            burned: null,
            squeeze_pct: null,
            held: 1,
          },
        ],
      }),
    })
    await waitFor(() => expect(screen.getByText("Damian Lillard")).toBeTruthy())
    expect(screen.getByText("75.0%")).toBeTruthy() // fmtPct keeps one decimal
    expect(screen.getByText("LEGENDARY")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/null|NaN/)
  })

  it("renders top sets and recent acquisitions when present", async () => {
    await runReport({
      squeeze: squeeze(),
      top_sets: [
        {
          set_name: "Base Set",
          owned_eds: 40,
          set_total_eds: 50,
          completion_pct: 80,
          total_moments_held: 55,
        },
      ],
      recent_acquisitions: [
        {
          player_name: "Recent Player",
          set_name: "Base Set",
          tier: "RARE",
          sold_at: new Date().toISOString(),
          price_usd: 120,
        },
      ],
    })
    // "Base Set" appears in both the top-sets table and the acquisitions list.
    await waitFor(() => expect(screen.getAllByText("Base Set").length).toBeGreaterThan(0))
    expect(screen.getByText("Recent Player")).toBeTruthy()
    const text = document.body.textContent ?? ""
    expect(text).toContain("Top Sets In Progress")
    expect(text).toContain("80.0%") // completion_pct through fmtPct
  })

  it("renders the relative-date ladder for acquisitions", async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    await runReport({
      squeeze: squeeze(),
      recent_acquisitions: [
        { player_name: "Today P", set_name: "S", tier: "COMMON", sold_at: days(0), price_usd: 1 },
        { player_name: "Yesterday P", set_name: "S", tier: "COMMON", sold_at: days(1), price_usd: 1 },
        { player_name: "Week P", set_name: "S", tier: "COMMON", sold_at: days(9), price_usd: 1 },
        { player_name: "Month P", set_name: "S", tier: "COMMON", sold_at: days(70), price_usd: 1 },
        { player_name: "Year P", set_name: "S", tier: "COMMON", sold_at: days(800), price_usd: 1 },
        { player_name: "Bad P", set_name: "S", tier: "COMMON", sold_at: "not-a-date", price_usd: 1 },
      ],
    })
    await waitFor(() => expect(screen.getByText("Today P")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("today")
    expect(text).toContain("1d ago")
    expect(text).toContain("9d ago")
    expect(text).toMatch(/2mo ago/)
    expect(text).toMatch(/2y ago/)
    // An unparseable timestamp must not render "Invalid Date" to a visitor.
    expect(text).not.toMatch(/Invalid Date/)
  })

  it("auto-loads from ?wallet= and skips the fetch for a malformed one", async () => {
    window.history.replaceState({}, "", `/insights/tc-report?wallet=${VALID_WALLET}`)
    const ok = jsonOnce({ squeeze: squeeze() })
    vi.stubGlobal("fetch", ok)
    render(<TcReportPage />)
    await waitFor(() => expect(ok).toHaveBeenCalled())
    cleanup()

    window.history.replaceState({}, "", "/insights/tc-report?wallet=garbage")
    const never = jsonOnce({})
    vi.stubGlobal("fetch", never)
    render(<TcReportPage />)
    // A junk URL param must never reach the API — the regex gate is the point.
    await waitFor(() => expect(screen.getByText(/Top Collector Report/i)).toBeTruthy())
    expect(never).not.toHaveBeenCalled()
  })

  it("shows a failure message when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down")))
    )
    render(<TcReportPage />)
    fireEvent.change(screen.getByLabelText(/Flow wallet address/i), {
      target: { value: VALID_WALLET },
    })
    fireEvent.click(screen.getByText(/Run report/i))
    // A thrown fetch must surface as an error, not as an empty report that
    // reads like "this collector owns nothing".
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeTruthy())
  })
})

describe("PackRealityPage — board formatting + degraded states", () => {
  function boardPayload(over: Record<string, unknown> = {}) {
    return {
      meta: { fetched_at: "2026-08-11T00:00:00Z", errors: [] },
      stats: {
        rips_60d: 1234,
        zero_value_rips: 100,
        zero_value_pct: 8.1,
        mean_pull_value_usd: 42.5,
        median_pull_value_usd: 420,
        p90_pull_value_usd: 4200,
        p99_pull_value_usd: 42000,
        rips_over_100: 300,
        rips_over_100_pct: 24.3,
        rips_over_1000: 12,
      },
      distribution: [
        { bucket: "0-25%", rips: 400, pct: 40 },
        { bucket: "25-50%", rips: 300, pct: 30 },
        { bucket: "50%+", rips: 300, pct: 30 },
      ],
      top_ev: [
        {
          pack_listing_id: "L1",
          dist_id: "1",
          pack_name: "Test Pack",
          pack_price: 42000,
          gross_ev: 46000,
          pack_ev: 4200,
          value_ratio: 1.5,
          fmv_coverage_pct: 92,
          edition_count: 20,
          total_unopened: 500,
          depletion_pct: 40,
          snapshotted_at: "2026-08-11T00:00:00Z",
          price_source: "primary",
          high_variance: false,
          is_reward_pack: false,
          retail_price_usd_normalized: 42000,
        },
        {
          pack_listing_id: "L2",
          dist_id: "2",
          // Null-heavy row: display must degrade to em-dashes, never NaN.
          pack_name: null,
          pack_price: 420,
          gross_ev: 500,
          pack_ev: 42.5,
          // The high-variance clamp: a ratio above 10 must render "10x+"
          // rather than an implausible precise multiple.
          value_ratio: 42,
          fmv_coverage_pct: null,
          edition_count: null,
          total_unopened: null,
          depletion_pct: null,
          snapshotted_at: null,
          price_source: null,
          high_variance: true,
          is_reward_pack: false,
          retail_price_usd_normalized: null,
        },
      ],
      ...over,
    }
  }

  it("renders the distribution bars and the EV table across formatter bands", async () => {
    vi.stubGlobal("fetch", jsonOnce(boardPayload()))
    render(<PackRealityPage />)
    await waitFor(() => expect(screen.getByText("Test Pack")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("$42k")
    expect(text).toContain("$4.2k")
    expect(text).toContain("$420")
    expect(text).toContain("$42.50")
    // The clamp, not a raw 42×.
    expect(text).toContain("10×+")
    expect(text).not.toMatch(/null|NaN/)
  })

  it("renders the empty state when no packs qualify", async () => {
    vi.stubGlobal("fetch", jsonOnce(boardPayload({ top_ev: [], distribution: [] })))
    render(<PackRealityPage />)
    // An empty board is an honest answer and must render as one — distinct
    // from the error state below.
    await waitFor(() =>
      expect(document.body.textContent).not.toMatch(/Test Pack/)
    )
    expect(screen.queryByText(/HTTP 500/)).toBeNull()
  })

  it("surfaces a non-ok response as an error rather than an empty board", async () => {
    vi.stubGlobal("fetch", jsonOnce({}, false, 500))
    render(<PackRealityPage />)
    // The distinction that matters: an outage must not render as "no
    // positive-EV packs exist right now", which is a claim about the market.
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 500|error|failed/i))

    // ⚠ THIS ASSERTION IS THE POINT, AND IT WAS MISSING UNTIL 2026-08-15.
    // The comment above stated the contract correctly from the day it was
    // written; the assertion only proved an error string appeared SOMEWHERE on
    // the page. Both can be true at once, and were: `error` was consulted by
    // exactly ONE of five claim sites (the pull-value distribution), so a 503
    // rendered "Failed to load: HTTP 500" in that section while "No +EV packs
    // right now." and "No qualifying packs yet." sat directly below it. Assert
    // what the READER SEES, not merely that a failure was mentioned.
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("No +EV packs right now.")
    expect(text).not.toContain("No qualifying packs yet.")
    // The prose count is a measurement only when the read succeeded; a hard
    // "0 positive-EV TS packs" reads as a finding.
    expect(text).not.toContain("0 positive-EV")
  })

  it("an empty-but-successful board still reads as empty, not as an outage", async () => {
    // ⚠ THE OTHER DIRECTION, and it is load-bearing. An empty board is an
    // HONEST market answer and must keep saying so — a fix that blanks every
    // empty state into "unavailable" cries wolf on the board working as
    // designed, which is the cost `board-status.ts` already warns about.
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        meta: { fetched_at: "2026-08-15T00:00:00Z", errors: [] },
        stats: {},
        distribution: [],
        top_ev: [],
      })
    )
    render(<PackRealityPage />)
    await waitFor(() =>
      expect(document.body.textContent).toContain("No +EV packs right now.")
    )
    const text = document.body.textContent ?? ""
    expect(text).toContain("No qualifying packs yet.")
    // ...and the read DID succeed, so the count is a real measurement.
    expect(text).toContain("0 positive-EV")
    expect(text).not.toContain("not a reading of the market")
  })

  it("an empty board caused by OUR STALE PRICES must not claim the market is empty", async () => {
    // ⚠ THE THIRD STATE, and it was live in production on 2026-09-01. The two
    // tests above cover "read failed" and "read ok + genuinely empty". There is
    // a third: the read succeeds, the board is empty, and the ONLY reason is
    // that our own pack prices are too stale to pass the ranker's 48h freshness
    // clause. Measured that day: 3 packs passed every other filter, aged 107h,
    // 113h and 130h, because their secondary-ask source is the dead
    // public-api.nbatopshot.com endpoint. The page said "No +EV packs right
    // now." — a claim about the MARKET, made out of a fact about US.
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        meta: {
          fetched_at: "2026-09-02T00:00:00Z",
          errors: [],
          ranker_staleness: {
            stale_count: 3,
            // Well outside the 48h window relative to any plausible test clock.
            newest_qualifying_snapshot: new Date(Date.now() - 130 * 3600_000).toISOString(),
          },
        },
        stats: {},
        distribution: [],
        top_ev: [],
      })
    )
    render(<PackRealityPage />)
    await waitFor(() => expect(document.body.textContent).toMatch(/stale/i))

    const text = document.body.textContent ?? ""
    // ⚠ THE ASSERTION THAT IS THE POINT: the ABSENCE of the false claim, not the
    // presence of new copy. A test that only checked for the word "stale" would
    // pass even if the market claim were still rendered beside it — which is
    // exactly how the 2026-08-15 defect survived its own comment.
    expect(text).not.toContain("No +EV packs right now.")
    // And it must attribute the emptiness to us rather than to the market.
    expect(text).toContain("not a reading of the market")
    expect(text).toMatch(/5 days ago/)
  })

  it("names the degraded upstreams when meta.errors is populated", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOnce(boardPayload({ meta: { errors: [{ source: "pack_ev" }, { source: "brand_new_source" }] } }))
    )
    render(<PackRealityPage />)
    await waitFor(() => expect(screen.getByText("Test Pack")).toBeTruthy())
    // An unmapped source must still be named rather than dropped — a silently
    // omitted degradation notice is the failure-renders-as-data class.
    expect(document.body.textContent).toContain("brand_new_source")
  })

  it("ignores an AbortError without painting an error", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abort))
    )
    render(<PackRealityPage />)
    // Unmount-driven aborts are routine; they must not flash an error banner.
    await waitFor(() => expect(screen.getByText(/Pack Reality/i)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/aborted/i)
  })
})
